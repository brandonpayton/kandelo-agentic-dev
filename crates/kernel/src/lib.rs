#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_main)]
#![cfg_attr(target_arch = "wasm64", feature(simd_wasm64))]

extern crate alloc;
extern crate wasm_posix_shared;

pub mod audio;
pub mod devfs;
pub mod fd;
pub mod fork;
pub mod ipc;
pub mod lock;
pub mod memory;
pub mod mouse;
pub mod mqueue;
pub mod ofd;
pub mod path;
pub mod pipe;
pub mod process;
pub mod process_table;
pub mod procfs;
pub mod pshared;
pub mod pty;
pub mod signal;
pub mod socket;
pub mod spawn;
pub mod syscalls;
pub mod terminal;
pub mod unix_socket;
pub mod wakeup;

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub mod wasm_api;

// ---------------------------------------------------------------------------
// Debug logging (temporary)
// ---------------------------------------------------------------------------

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
pub fn debug_log(msg: &str) {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn host_debug_log(ptr: *const u8, len: u32);
    }
    unsafe {
        host_debug_log(msg.as_ptr(), msg.len() as u32);
    }
}

#[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
pub fn debug_log(_msg: &str) {}

// ---------------------------------------------------------------------------
// Current time helper
// ---------------------------------------------------------------------------

/// Get current real time in seconds (CLOCK_REALTIME).
/// On wasm32, calls the host import. On native (tests), returns 0.
pub fn current_time_secs() -> i64 {
    #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
    {
        #[link(wasm_import_module = "env")]
        unsafe extern "C" {
            fn host_clock_gettime(clock_id: u32, sec_ptr: *mut i64, nsec_ptr: *mut i64) -> i32;
        }
        let mut sec: i64 = 0;
        let mut nsec: i64 = 0;
        unsafe {
            host_clock_gettime(0, &mut sec as *mut i64, &mut nsec as *mut i64);
        }
        sec
    }
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    {
        0
    }
}

// ---------------------------------------------------------------------------
// Kernel mode flag
// ---------------------------------------------------------------------------

use core::sync::atomic::{AtomicU32, Ordering};

/// Kernel operating mode.
///
/// - Mode 0 (default): Traditional per-process kernel. Blocking syscalls spin
///   or delegate to the host. Used by existing single-kernel-per-worker setup.
/// - Mode 1: Centralized kernel. Blocking syscalls return EAGAIN immediately
///   so the host JS event loop can handle waiting asynchronously.
static KERNEL_MODE: AtomicU32 = AtomicU32::new(0);

/// Returns true when the kernel is running in centralized mode (mode 1).
/// In this mode, syscalls that would block instead return EAGAIN so the
/// host can retry them asynchronously.
#[inline]
pub fn is_centralized_mode() -> bool {
    KERNEL_MODE.load(Ordering::Relaxed) != 0
}

/// Set the kernel operating mode. Called from wasm_api or tests.
pub fn set_kernel_mode(mode: u32) {
    KERNEL_MODE.store(mode, Ordering::Relaxed);
}

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::sync::atomic::{AtomicI32, Ordering};

    struct KernelAllocator {
        lock: AtomicI32,
        inner: UnsafeCell<dlmalloc::Dlmalloc>,
    }

    unsafe impl Sync for KernelAllocator {}

    impl KernelAllocator {
        const fn new() -> Self {
            Self {
                lock: AtomicI32::new(0),
                inner: UnsafeCell::new(dlmalloc::Dlmalloc::new()),
            }
        }

        fn acquire(&self) -> AllocGuard<'_> {
            while self
                .lock
                .compare_exchange_weak(0, 1, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                core::hint::spin_loop();
            }
            AllocGuard { allocator: self }
        }
    }

    struct AllocGuard<'a> {
        allocator: &'a KernelAllocator,
    }

    impl Drop for AllocGuard<'_> {
        fn drop(&mut self) {
            self.allocator.lock.store(0, Ordering::Release);
        }
    }

    unsafe impl GlobalAlloc for KernelAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _guard = self.acquire();
            unsafe { (&mut *self.inner.get()).malloc(layout.size(), layout.align()) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            let _guard = self.acquire();
            unsafe { (&mut *self.inner.get()).free(ptr, layout.size(), layout.align()) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let _guard = self.acquire();
            unsafe { (&mut *self.inner.get()).calloc(layout.size(), layout.align()) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let _guard = self.acquire();
            unsafe {
                (&mut *self.inner.get()).realloc(ptr, layout.size(), layout.align(), new_size)
            }
        }
    }

    #[global_allocator]
    static ALLOC: KernelAllocator = KernelAllocator::new();

    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo) -> ! {
        unsafe { core::hint::unreachable_unchecked() }
    }
}
