//! Call-graph discovery.
//!
//! Given a seed function (typically an imported async function like
//! `kernel.kernel_fork`), computes the set of functions in the module
//! that can transitively reach the seed via calls.
//!
//! Discovery follows direct calls and table-aware indirect calls. An
//! indirect call can only reach functions that may inhabit the same
//! table as that `call_indirect` instruction, with the same signature.

use std::collections::{HashMap, HashSet, VecDeque};

use walrus::ir::{
    Call, CallIndirect, RefFunc, ReturnCall, ReturnCallIndirect, TableCopy, TableFill, TableGrow,
    TableInit, TableSet, Visitor, dfs_in_order,
};
use walrus::{
    ElementId, ElementItems, ElementKind, FunctionId, GlobalKind, ImportKind, Module, TableId,
    TypeId,
};

/// Look up a function by its qualified import name (e.g.
/// `"kernel.kernel_fork"`). Returns `None` if the module has no such
/// import or if the import exists but isn't a function.
pub fn find_import_func(module: &Module, qualified_name: &str) -> Option<FunctionId> {
    let (mod_name, field) = qualified_name.split_once('.')?;
    for import in module.imports.iter() {
        if import.module == mod_name && import.name == field {
            if let ImportKind::Function(id) = import.kind {
                return Some(id);
            }
        }
    }
    None
}

/// Walks a single local function, collecting every `Call` target
/// and every indirect-call site.
#[derive(Default)]
struct CollectCalls {
    direct: HashSet<FunctionId>,
    indirect: HashSet<IndirectCall>,
    table_inits: Vec<(ElementId, TableId)>,
    table_copies: Vec<(TableId, TableId)>,
    dynamic_table_writes: HashSet<TableId>,
    ref_funcs: HashSet<FunctionId>,
}

impl<'a> Visitor<'a> for CollectCalls {
    fn visit_call(&mut self, instr: &Call) {
        self.direct.insert(instr.func);
    }

    fn visit_return_call(&mut self, instr: &ReturnCall) {
        self.direct.insert(instr.func);
    }

    fn visit_call_indirect(&mut self, instr: &CallIndirect) {
        self.indirect.insert(IndirectCall {
            table: instr.table,
            ty: instr.ty,
        });
    }

    fn visit_return_call_indirect(&mut self, instr: &ReturnCallIndirect) {
        self.indirect.insert(IndirectCall {
            table: instr.table,
            ty: instr.ty,
        });
    }

    fn visit_table_init(&mut self, instr: &TableInit) {
        self.table_inits.push((instr.elem, instr.table));
    }

    fn visit_table_copy(&mut self, instr: &TableCopy) {
        self.table_copies.push((instr.src, instr.dst));
    }

    fn visit_table_set(&mut self, instr: &TableSet) {
        self.dynamic_table_writes.insert(instr.table);
    }

    fn visit_table_fill(&mut self, instr: &TableFill) {
        self.dynamic_table_writes.insert(instr.table);
    }

    fn visit_table_grow(&mut self, instr: &TableGrow) {
        self.dynamic_table_writes.insert(instr.table);
    }

    fn visit_ref_func(&mut self, instr: &RefFunc) {
        self.ref_funcs.insert(instr.func);
    }
}

/// Per-function analysis: what it directly calls and what
/// indirect calls/table operations it uses.
struct FuncProfile {
    direct: HashSet<FunctionId>,
    indirect: HashSet<IndirectCall>,
    table_inits: Vec<(ElementId, TableId)>,
    table_copies: Vec<(TableId, TableId)>,
    dynamic_table_writes: HashSet<TableId>,
    ref_funcs: HashSet<FunctionId>,
}

fn profile_functions(module: &Module) -> HashMap<FunctionId, FuncProfile> {
    let mut profiles = HashMap::new();
    for (id, func) in module.funcs.iter_local() {
        let mut collector = CollectCalls::default();
        dfs_in_order(&mut collector, func, func.entry_block());
        profiles.insert(
            id,
            FuncProfile {
                direct: collector.direct,
                indirect: collector.indirect,
                table_inits: collector.table_inits,
                table_copies: collector.table_copies,
                dynamic_table_writes: collector.dynamic_table_writes,
                ref_funcs: collector.ref_funcs,
            },
        );
    }
    profiles
}

/// Build the reverse call graph: a map from callee to set of direct
/// callers. Only includes edges originating from local (non-imported)
/// functions, since imported functions have no body to scan.
pub fn build_reverse_call_graph(module: &Module) -> HashMap<FunctionId, HashSet<FunctionId>> {
    let mut reverse: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller_id, profile) in profile_functions(module) {
        for callee in profile.direct {
            reverse.entry(callee).or_default().insert(caller_id);
        }
    }
    reverse
}

/// Compute the transitive closure of functions that reach `seed` via
/// direct calls. Result always includes `seed` itself.
pub fn direct_reaching_closure(module: &Module, seed: FunctionId) -> HashSet<FunctionId> {
    let reverse = build_reverse_call_graph(module);
    let mut result = HashSet::new();
    let mut queue = VecDeque::new();
    result.insert(seed);
    queue.push_back(seed);
    while let Some(f) = queue.pop_front() {
        if let Some(callers) = reverse.get(&f) {
            for &caller in callers {
                if result.insert(caller) {
                    queue.push_back(caller);
                }
            }
        }
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct IndirectCall {
    table: TableId,
    ty: TypeId,
}

/// Extract concrete function references from an element segment's item list.
fn element_functions(items: &ElementItems) -> HashSet<FunctionId> {
    let mut result = HashSet::new();

    match items {
        ElementItems::Functions(ids) => {
            for id in ids {
                result.insert(*id);
            }
        }
        ElementItems::Expressions(_ref_ty, init_exprs) => {
            // An init expression produces one value. For function-ref
            // element segments, LLVM emits `ref.func $f`, which walrus
            // stores as `ConstExpr::RefFunc`.
            for expr in init_exprs {
                result.extend(const_expr_functions(expr));
            }
        }
    }

    result
}

fn const_expr_functions(expr: &walrus::ConstExpr) -> HashSet<FunctionId> {
    let mut result = HashSet::new();
    match expr {
        walrus::ConstExpr::RefFunc(f) => {
            result.insert(*f);
        }
        walrus::ConstExpr::Extended(ops) => {
            for op in ops {
                if let walrus::ConstOp::RefFunc(f) = op {
                    result.insert(*f);
                }
            }
        }
        // Other ConstExpr variants (Value, Global, RefNull) don't yield
        // a concrete function.
        _ => {}
    }
    result
}

#[derive(Default)]
struct TableTargets {
    funcs_by_table: HashMap<TableId, HashSet<FunctionId>>,
    dynamic_tables: HashSet<TableId>,
    dynamic_funcs: HashSet<FunctionId>,
}

impl TableTargets {
    fn matching_funcs(&self, module: &Module, table: TableId, ty: TypeId) -> HashSet<FunctionId> {
        let mut result = HashSet::new();

        if let Some(funcs) = self.funcs_by_table.get(&table) {
            result.extend(
                funcs
                    .iter()
                    .copied()
                    .filter(|func| types_match(module, function_type_id(module, *func), ty)),
            );
        }

        if self.dynamic_tables.contains(&table) {
            result.extend(
                self.dynamic_funcs
                    .iter()
                    .copied()
                    .filter(|func| types_match(module, function_type_id(module, *func), ty)),
            );
        }

        result
    }
}

/// Enumerate possible `call_indirect` targets per table.
///
/// Active element segments populate exactly one table and are the common LLVM
/// function-pointer-table case. Passive segments are not table-addressable by
/// themselves; they become possible targets only for tables that the module
/// initializes from that segment with `table.init`. Declared segments never
/// initialize a table, so they are intentionally ignored here.
///
/// Dynamic table writes (`table.set`, `table.fill`, `table.grow`) can place
/// references this static pass cannot recover. For those tables, the possible
/// target set is the module's address-taken functions: functions present in
/// element segments, constant `ref.func` initializers, or executable
/// `ref.func` instructions. Treating such a table as containing every module
/// function is too broad for fork instrumentation because it marks ordinary
/// syscall and allocation paths as fork paths. `table.copy` propagates known
/// and dynamic target sets from source to destination.
fn table_targets(module: &Module, profiles: &HashMap<FunctionId, FuncProfile>) -> TableTargets {
    let mut targets = TableTargets::default();
    let mut passive_table_inits: HashMap<ElementId, HashSet<TableId>> = HashMap::new();
    let mut table_copies = Vec::new();

    for profile in profiles.values() {
        for &(elem, table) in &profile.table_inits {
            passive_table_inits.entry(elem).or_default().insert(table);
        }
        table_copies.extend(profile.table_copies.iter().copied());
        targets
            .dynamic_tables
            .extend(profile.dynamic_table_writes.iter().copied());
        targets
            .dynamic_funcs
            .extend(profile.ref_funcs.iter().copied());
    }

    for table in module.tables.iter() {
        if let Some(init) = &table.init {
            let funcs = const_expr_functions(init);
            targets.dynamic_funcs.extend(funcs.iter().copied());
            targets
                .funcs_by_table
                .entry(table.id())
                .or_default()
                .extend(funcs);
        }
    }

    for global in module.globals.iter() {
        targets
            .dynamic_funcs
            .extend(global_kind_functions(&global.kind));
    }

    for elem in module.elements.iter() {
        let funcs = element_functions(&elem.items);
        if funcs.is_empty() {
            continue;
        }
        targets.dynamic_funcs.extend(funcs.iter().copied());
        match &elem.kind {
            ElementKind::Active { table, .. } => {
                targets
                    .funcs_by_table
                    .entry(*table)
                    .or_default()
                    .extend(funcs);
            }
            ElementKind::Passive => {
                if let Some(tables) = passive_table_inits.get(&elem.id()) {
                    for &table in tables {
                        targets
                            .funcs_by_table
                            .entry(table)
                            .or_default()
                            .extend(funcs.iter().copied());
                    }
                }
            }
            ElementKind::Declared => {}
        }
    }

    let mut changed = true;
    while changed {
        changed = false;
        for &(src, dst) in &table_copies {
            if targets.dynamic_tables.contains(&src) && targets.dynamic_tables.insert(dst) {
                changed = true;
            }

            let Some(src_funcs) = targets.funcs_by_table.get(&src).cloned() else {
                continue;
            };
            let dst_funcs = targets.funcs_by_table.entry(dst).or_default();
            let old_len = dst_funcs.len();
            dst_funcs.extend(src_funcs);
            if dst_funcs.len() != old_len {
                changed = true;
            }
        }
    }

    targets
}

fn global_kind_functions(kind: &GlobalKind) -> HashSet<FunctionId> {
    match kind {
        GlobalKind::Local(expr) => const_expr_functions(expr),
        GlobalKind::Import(_) => HashSet::new(),
    }
}

/// A function's signature, used for comparing against `call_indirect`
/// type indices. Walrus stores each function's type as a `TypeId` on
/// the function itself; looking up the `Type` lets us get its
/// parameters and results.
fn function_type_id(module: &Module, id: FunctionId) -> TypeId {
    module.funcs.get(id).ty()
}

/// Check whether two type ids refer to structurally identical
/// function types (same params, same results). For modern wasm with
/// type indices the ids usually match exactly when two functions
/// share a signature, but we compare structurally to be robust to
/// modules where the same signature has multiple type-section entries.
fn types_match(module: &Module, a: TypeId, b: TypeId) -> bool {
    if a == b {
        return true;
    }
    let ta = module.types.get(a);
    let tb = module.types.get(b);
    ta.params() == tb.params() && ta.results() == tb.results()
}

fn is_indirect_trampoline(profile: &FuncProfile) -> bool {
    profile.direct.is_empty() && profile.indirect.len() == 1
}

const MAX_INDIRECT_DEPTH: u8 = 2;

#[derive(Debug, Clone)]
pub enum ReachReason {
    Seed,
    DirectCall {
        callee: FunctionId,
    },
    IndirectCall {
        target: FunctionId,
        table: TableId,
        ty: TypeId,
        indirect_depth: u8,
    },
}

#[derive(Debug)]
pub struct ReachingTrace {
    pub reached: HashSet<FunctionId>,
    pub reasons: HashMap<FunctionId, ReachReason>,
}

/// Compute the transitive closure of functions that reach `seed` via
/// direct calls, plus a bounded number of table/function-pointer dispatches.
///
/// A function `F` reaches `seed` if any of these hold:
///   (1) `F == seed`
///   (2) `F` directly calls some function `G` that reaches `seed`
///   (3) `F` executes `call_indirect` of type `T`, and some
///       function `G` of type `T` reaches `seed` and may inhabit the
///       same table that `F` indexes
///
/// Rule 3 is intentionally bounded. Functions discovered through indirect
/// edges still pull in their direct callers, but after `MAX_INDIRECT_DEPTH`
/// indirect hops they do not become new indirect roots. Depth 2 covers the
/// common C/POSIX callback cases plus QuickJS's C-function trampoline
/// (`JS_CallInternal -> js_call_c_function -> js_os_exec`) while avoiding
/// whole-runtime closure in dynamic interpreters where a generic dispatcher
/// can theoretically call thousands of same-table, same-signature callbacks.
///
/// Ambiguous table/signature matches are followed for the first indirect hop
/// out of the direct fork path. That covers real C dispatcher frames such as
/// Tcl command dispatch (`Dispatch -> Tcl_OpenObjCmd -> fork`) that must be
/// saved for fork unwind. Ambiguous second-hop matches are only followed
/// through simple indirect trampolines (no direct calls, exactly one
/// `call_indirect`), which covers Tcl's NR callback dispatch into `Dispatch`.
/// Broader ambiguous second-hop matches are not safe without index value-flow:
/// in large C modules they cross unrelated callback domains (for example
/// SQLite VFS callbacks into libc signal delivery) and instrument
/// syscall/allocation paths that do not actually fork. Unambiguous table
/// matches can still use the bounded two-hop path.
pub fn reaching_closure(module: &Module, seed: FunctionId) -> HashSet<FunctionId> {
    reaching_closure_with_reasons(module, seed).reached
}

pub fn reaching_closure_with_reasons(module: &Module, seed: FunctionId) -> ReachingTrace {
    let profiles = profile_functions(module);
    let table_targets = table_targets(module, &profiles);

    // Reverse direct-call graph: `callee -> set of callers`.
    let mut reverse_direct: HashMap<FunctionId, HashSet<FunctionId>> = HashMap::new();
    for (caller, profile) in &profiles {
        for callee in &profile.direct {
            reverse_direct.entry(*callee).or_default().insert(*caller);
        }
    }

    // Reverse indirect-call graph: `(table, call_indirect type T) ->
    // callers that index that table with type T`. We compare types
    // structurally (§types_match); TypeId is still stored and compared
    // at lookup time rather than forcing exact type-index equality.
    let indirect_callers: Vec<(IndirectCall, FunctionId)> = profiles
        .iter()
        .flat_map(|(caller, profile)| {
            profile
                .indirect
                .iter()
                .map(move |indirect| (*indirect, *caller))
        })
        .collect();

    // First compute the direct-only closure. Every function in this set
    // reaches the seed without crossing a function-pointer dispatch, so it
    // is safe to use as an indirect root below.
    let mut result = HashSet::new();
    let mut reasons = HashMap::new();
    let mut direct_queue = VecDeque::new();
    result.insert(seed);
    reasons.insert(seed, ReachReason::Seed);
    direct_queue.push_back(seed);
    while let Some(g) = direct_queue.pop_front() {
        if let Some(callers) = reverse_direct.get(&g) {
            for &caller in callers {
                if result.insert(caller) {
                    reasons.insert(caller, ReachReason::DirectCall { callee: g });
                    direct_queue.push_back(caller);
                }
            }
        }
    }

    let direct_roots = result.clone();
    let mut best_indirect_depth: HashMap<FunctionId, u8> =
        direct_roots.iter().map(|&id| (id, 0)).collect();
    let mut worklist: VecDeque<(FunctionId, u8)> = direct_roots.iter().map(|&id| (id, 0)).collect();
    let mut matching_cache: HashMap<IndirectCall, HashSet<FunctionId>> = HashMap::new();

    fn enqueue(
        func: FunctionId,
        indirect_depth: u8,
        best_indirect_depth: &mut HashMap<FunctionId, u8>,
        reasons: &mut HashMap<FunctionId, ReachReason>,
        result: &mut HashSet<FunctionId>,
        worklist: &mut VecDeque<(FunctionId, u8)>,
        reason: ReachReason,
    ) {
        let should_enqueue = match best_indirect_depth.get(&func) {
            Some(&old_depth) => indirect_depth < old_depth,
            None => true,
        };
        if should_enqueue {
            best_indirect_depth.insert(func, indirect_depth);
            reasons.insert(func, reason);
            result.insert(func);
            worklist.push_back((func, indirect_depth));
        }
    }

    while let Some((g, indirect_depth)) = worklist.pop_front() {
        // (2) Direct-reverse: who calls g directly?
        if let Some(callers) = reverse_direct.get(&g) {
            for &caller in callers {
                enqueue(
                    caller,
                    indirect_depth,
                    &mut best_indirect_depth,
                    &mut reasons,
                    &mut result,
                    &mut worklist,
                    ReachReason::DirectCall { callee: g },
                );
            }
        }

        // (3) Indirect-reverse: every function that does
        // `call_indirect` with g's signature against a table that can
        // contain g might be reaching g. Add those callers.
        if indirect_depth < MAX_INDIRECT_DEPTH {
            for &(indirect, caller) in &indirect_callers {
                let matching = matching_cache.entry(indirect).or_insert_with(|| {
                    table_targets.matching_funcs(module, indirect.table, indirect.ty)
                });
                let unambiguous = matching.len() == 1;
                let first_indirect_hop = indirect_depth == 0;
                let trampoline_second_hop =
                    indirect_depth == 1 && profiles.get(&g).is_some_and(is_indirect_trampoline);
                if matching.contains(&g)
                    && (unambiguous || first_indirect_hop || trampoline_second_hop)
                {
                    enqueue(
                        caller,
                        indirect_depth + 1,
                        &mut best_indirect_depth,
                        &mut reasons,
                        &mut result,
                        &mut worklist,
                        ReachReason::IndirectCall {
                            target: g,
                            table: indirect.table,
                            ty: indirect.ty,
                            indirect_depth: indirect_depth + 1,
                        },
                    );
                }
            }
        }
    }

    ReachingTrace {
        reached: result,
        reasons,
    }
}

/// Human-readable name for a function, for logging and JSON output.
/// Uses the function's own `name` field if set (preserved from the
/// wasm name section); otherwise synthesizes `func[N]` from the
/// function's index.
pub fn func_display_name(module: &Module, id: FunctionId) -> String {
    let func = module.funcs.get(id);
    if let Some(name) = &func.name {
        name.clone()
    } else {
        // Fall back to a stable synthetic label.
        format!("func#{:?}", id)
    }
}

/// A classification of a discovered function for JSON output.
#[derive(Debug)]
pub struct FuncEntry {
    pub name: String,
    pub is_import: bool,
}

/// Summarize a set of function IDs as sorted `FuncEntry` records.
/// Sorting is stable across runs so that diff-based validation works.
pub fn summarize(module: &Module, ids: &HashSet<FunctionId>) -> Vec<FuncEntry> {
    let mut entries: Vec<FuncEntry> = ids
        .iter()
        .map(|&id| {
            let func = module.funcs.get(id);
            FuncEntry {
                name: func_display_name(module, id),
                is_import: matches!(func.kind, walrus::FunctionKind::Import(_)),
            }
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}
