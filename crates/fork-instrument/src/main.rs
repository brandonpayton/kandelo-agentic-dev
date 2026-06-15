//! CLI frontend for `fork-instrument`.
//!
//! Usage:
//!
//! ```text
//! wasm-fork-instrument <input.wasm> -o <output.wasm> [--entry kernel.kernel_fork]
//! ```
//!
//! Exits non-zero with a human-readable error on any failure (parse,
//! validation, or instrumentation). Errors include the input file path
//! and the operation that failed.

use anyhow::{Context, Result, bail};
use clap::Parser;
use std::fs;
use std::path::PathBuf;

use fork_instrument::{
    Options, analyze,
    call_graph::{self, ReachReason},
    instrument,
};

#[derive(Debug, Parser)]
#[command(
    name = "wasm-fork-instrument",
    about = "Instrument a wasm module with save/restore machinery for POSIX fork()",
    long_about = None,
)]
struct Cli {
    /// Input wasm file to instrument.
    input: PathBuf,

    /// Output path for the instrumented wasm file. Required unless
    /// `--discover-only` is set (analysis-only mode).
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// The fully-qualified name of the import that triggers unwind.
    /// Format: `module.field`. Defaults to `kernel.kernel_fork`.
    #[arg(long, default_value = "kernel.kernel_fork")]
    entry: String,

    /// Analyze the module and print the discovered fork-path function
    /// set as JSON to stdout. Skips instrumentation and output emission.
    /// Useful for validating call-graph discovery against
    /// hand-maintained onlylists.
    #[arg(long)]
    discover_only: bool,

    /// Explain why the named function is in the discovered fork path.
    /// Prints a predecessor chain back to the entry import.
    #[arg(long, value_name = "FUNC")]
    explain_func: Option<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let input =
        fs::read(&cli.input).with_context(|| format!("reading input: {}", cli.input.display()))?;

    let opts = Options {
        entry_import: cli.entry,
    };

    if let Some(name) = cli.explain_func.as_deref() {
        print_function_explanation(&input, &opts, name)
            .with_context(|| format!("explaining fork path for {}", cli.input.display()))?;
        return Ok(());
    }

    if cli.discover_only {
        let analysis =
            analyze(&input, &opts).with_context(|| format!("analyzing {}", cli.input.display()))?;
        print_analysis_json(&analysis);
        return Ok(());
    }

    let output_path = cli
        .output
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("--output is required unless --discover-only is set"))?;

    let output = instrument(&input, &opts)
        .with_context(|| format!("instrumenting {}", cli.input.display()))?;

    fs::write(output_path, &output)
        .with_context(|| format!("writing output: {}", output_path.display()))?;

    Ok(())
}

fn print_function_explanation(input: &[u8], opts: &Options, name: &str) -> Result<()> {
    let module = walrus::Module::from_buffer(input).context("failed to parse input wasm module")?;
    let Some(entry) = call_graph::find_import_func(&module, &opts.entry_import) else {
        bail!("entry import `{}` not found", opts.entry_import);
    };
    let trace = call_graph::reaching_closure_with_reasons(&module, entry);

    let matches: Vec<_> = module
        .funcs
        .iter()
        .filter_map(|func| {
            let id = func.id();
            (call_graph::func_display_name(&module, id) == name).then_some(id)
        })
        .collect();

    match matches.as_slice() {
        [] => bail!("function `{name}` not found"),
        [target] => {
            if !trace.reached.contains(target) {
                println!("{name} is not in the discovered fork path.");
                return Ok(());
            }

            println!("{name} is in the discovered fork path:");
            let mut current = *target;
            let mut seen = std::collections::HashSet::new();
            for step in 0..128 {
                if !seen.insert(current) {
                    println!(
                        "  {step}: {} (cycle detected)",
                        func_label(&module, current)
                    );
                    break;
                }

                match trace.reasons.get(&current) {
                    Some(ReachReason::Seed) => {
                        println!(
                            "  {step}: {} is the seed import",
                            func_label(&module, current)
                        );
                        break;
                    }
                    Some(ReachReason::DirectCall { callee }) => {
                        println!(
                            "  {step}: {} directly calls {}",
                            func_label(&module, current),
                            func_label(&module, *callee)
                        );
                        current = *callee;
                    }
                    Some(ReachReason::ExternalDynamicCall { table, ty }) => {
                        println!(
                            "  {step}: {} has call_indirect table={table:?} type={ty:?}; \
                             dynamic-linking imports allow future side-module functions to occupy that table",
                            func_label(&module, current),
                        );
                        break;
                    }
                    Some(ReachReason::IndirectCall {
                        target,
                        table,
                        ty,
                        indirect_depth,
                    }) => {
                        println!(
                            "  {step}: {} has call_indirect table={table:?} type={ty:?}; \
                             target {} was already reachable at indirect depth {indirect_depth}",
                            func_label(&module, current),
                            func_label(&module, *target),
                        );
                        current = *target;
                    }
                    None => {
                        println!(
                            "  {step}: {} has no recorded reason",
                            func_label(&module, current)
                        );
                        break;
                    }
                }
            }
        }
        _ => bail!(
            "function name `{name}` is ambiguous: {} matches",
            matches.len()
        ),
    }

    Ok(())
}

fn func_label(module: &walrus::Module, id: walrus::FunctionId) -> String {
    format!("{} ({id:?})", call_graph::func_display_name(module, id))
}

fn print_analysis_json(analysis: &fork_instrument::Analysis) {
    // Hand-rolled JSON to avoid a serde dependency for a tiny output.
    // Format is one-entry-per-line array of `{name, is_import}` objects.
    println!("{{");
    println!("  \"fork_path\": [");
    for (i, entry) in analysis.fork_path.iter().enumerate() {
        let comma = if i + 1 == analysis.fork_path.len() {
            ""
        } else {
            ","
        };
        println!(
            "    {{ \"name\": {}, \"is_import\": {} }}{}",
            json_string(&entry.name),
            entry.is_import,
            comma,
        );
    }
    println!("  ],");
    println!("  \"count\": {}", analysis.fork_path.len());
    println!("}}");
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
