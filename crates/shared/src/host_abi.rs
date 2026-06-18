//! Host adapter ABI metadata.
//!
//! These tables describe how the JavaScript host adapter copies pointer
//! arguments between process memory and the kernel scratch channel before
//! calling `kernel_handle_channel`. The host still owns the memory copies and
//! platform scheduling; Rust owns the ABI-sensitive syscall argument shapes.

use core::mem::size_of;

use crate::abi::extended_syscalls as extra_syscalls;
use crate::{Syscall, WasmStat, WasmStatfs, WasmTimespec};

/// Direction of a marshalled pointer argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyscallArgDirection {
    In,
    Out,
    InOut,
}

/// How the host computes the byte length for a pointer argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyscallArgSize {
    /// A nul-terminated string in process memory.
    CString,
    /// Byte length comes from another syscall argument.
    Arg {
        arg_index: u8,
        multiplier: u32,
        add: u32,
    },
    /// Byte length is read as a little-endian `u32` through another pointer
    /// argument, e.g. `socklen_t *`.
    Deref { arg_index: u8 },
    /// Fixed byte length.
    Fixed { size: u32 },
}

/// One pointer argument descriptor for host-side marshalling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyscallArgDesc {
    pub arg_index: u8,
    pub direction: SyscallArgDirection,
    pub size: SyscallArgSize,
    /// Extra bytes to copy back when an output `Arg`-sized buffer's copied
    /// length is based on the syscall return value. `msgrcv` returns only
    /// `mtext` length, but the scratch buffer also includes the leading mtype.
    pub copy_retval_add: u32,
    /// Whether output copy-back for an `Arg`-sized buffer is capped by the
    /// syscall return value. This is correct for byte-count syscalls such as
    /// read(2), recv(2), and getdents(2), but not for syscalls whose return
    /// value is an element count while the buffer size is expressed in bytes
    /// (for example getgroups(2)).
    pub copy_retval_limit: bool,
}

/// All pointer argument descriptors for one syscall number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyscallArgDescriptor {
    pub syscall_number: u32,
    pub args: &'static [SyscallArgDesc],
}

macro_rules! cstring {
    () => {
        SyscallArgSize::CString
    };
}

macro_rules! arg {
    ($arg_index:expr) => {
        SyscallArgSize::Arg {
            arg_index: $arg_index,
            multiplier: 1,
            add: 0,
        }
    };
    ($arg_index:expr, mul $multiplier:expr) => {
        SyscallArgSize::Arg {
            arg_index: $arg_index,
            multiplier: $multiplier,
            add: 0,
        }
    };
    ($arg_index:expr, add $add:expr) => {
        SyscallArgSize::Arg {
            arg_index: $arg_index,
            multiplier: 1,
            add: $add,
        }
    };
}

macro_rules! deref {
    ($arg_index:expr) => {
        SyscallArgSize::Deref {
            arg_index: $arg_index,
        }
    };
}

macro_rules! fixed {
    ($size:expr) => {
        SyscallArgSize::Fixed { size: $size }
    };
}

macro_rules! desc {
    ($arg_index:expr, $direction:ident, $size:expr) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            copy_retval_add: 0,
            copy_retval_limit: true,
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, copy_retval_add $copy_retval_add:expr) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            copy_retval_add: $copy_retval_add,
            copy_retval_limit: true,
        }
    };
    ($arg_index:expr, $direction:ident, $size:expr, no_copy_retval_limit) => {
        SyscallArgDesc {
            arg_index: $arg_index,
            direction: SyscallArgDirection::$direction,
            size: $size,
            copy_retval_add: 0,
            copy_retval_limit: false,
        }
    };
}

macro_rules! entry {
    ($syscall_number:expr, [ $($desc:expr),* $(,)? ]) => {
        SyscallArgDescriptor {
            syscall_number: $syscall_number,
            args: &[$($desc),*],
        }
    };
}

const WASM_STAT_SIZE: u32 = size_of::<WasmStat>() as u32;
const WASM_TIMESPEC_SIZE: u32 = size_of::<WasmTimespec>() as u32;
const WASM_STATFS_SIZE: u32 = size_of::<WasmStatfs>() as u32;

const ITIMERVAL_SIZE: u32 = 16;
const RLIMIT_SIZE: u32 = 16;
const STACK_T_SIZE: u32 = 12;

/// Host-side syscall pointer argument descriptors.
///
/// The values are sorted by syscall number for deterministic codegen and
/// snapshot output.
pub const SYSCALL_ARG_DESCRIPTORS: &[SyscallArgDescriptor] = &[
    entry!(Syscall::Open as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Read as u32, [desc!(1, Out, arg!(2))]),
    entry!(Syscall::Write as u32, [desc!(1, In, arg!(2))]),
    entry!(
        Syscall::Fstat as u32,
        [desc!(1, Out, fixed!(WASM_STAT_SIZE))]
    ),
    entry!(Syscall::Pipe as u32, [desc!(0, Out, fixed!(8))]),
    entry!(
        Syscall::Stat as u32,
        [
            desc!(0, In, cstring!()),
            desc!(1, Out, fixed!(WASM_STAT_SIZE)),
        ]
    ),
    entry!(
        Syscall::Lstat as u32,
        [
            desc!(0, In, cstring!()),
            desc!(1, Out, fixed!(WASM_STAT_SIZE)),
        ]
    ),
    entry!(Syscall::Mkdir as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Rmdir as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Unlink as u32, [desc!(0, In, cstring!())]),
    entry!(
        Syscall::Rename as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(
        Syscall::Link as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(
        Syscall::Symlink as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(
        Syscall::Readlink as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, arg!(2)),]
    ),
    entry!(Syscall::Chmod as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Chown as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Access as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Getcwd as u32, [desc!(0, Out, arg!(1))]),
    entry!(Syscall::Chdir as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Opendir as u32, [desc!(0, In, cstring!())]),
    entry!(
        Syscall::Readdir as u32,
        [desc!(1, Out, fixed!(16)), desc!(2, Out, arg!(3)),]
    ),
    entry!(
        Syscall::Sigaction as u32,
        [desc!(1, In, fixed!(16)), desc!(2, Out, fixed!(16)),]
    ),
    entry!(
        Syscall::Sigprocmask as u32,
        [desc!(1, In, fixed!(8)), desc!(2, Out, fixed!(8)),]
    ),
    entry!(
        Syscall::ClockGettime as u32,
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::Nanosleep as u32,
        [desc!(0, In, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::GetEnv as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, arg!(2)),]
    ),
    entry!(
        Syscall::SetEnv as u32,
        [desc!(0, In, cstring!()), desc!(1, In, cstring!()),]
    ),
    entry!(Syscall::UnsetEnv as u32, [desc!(0, In, cstring!())]),
    entry!(Syscall::Bind as u32, [desc!(1, In, arg!(2))]),
    entry!(
        Syscall::Accept as u32,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
    entry!(Syscall::Connect as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Send as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Recv as u32, [desc!(1, Out, arg!(2))]),
    entry!(
        Syscall::Getsockopt as u32,
        [desc!(3, Out, deref!(4)), desc!(4, InOut, fixed!(4)),]
    ),
    entry!(Syscall::Setsockopt as u32, [desc!(3, In, arg!(4))]),
    entry!(Syscall::Poll as u32, [desc!(0, InOut, arg!(1, mul 8))]),
    entry!(Syscall::Socketpair as u32, [desc!(3, Out, fixed!(8))]),
    entry!(
        Syscall::Sendto as u32,
        [
            // Keep the small control address ahead of the payload in the
            // shared scratch buffer. A maximum-sized datagram may be capped
            // to fit the channel, but the destination sockaddr must never be
            // starved or the kernel would see a process-memory pointer.
            desc!(4, In, arg!(5)),
            desc!(1, In, arg!(2)),
        ]
    ),
    entry!(
        Syscall::Recvfrom as u32,
        [
            // Keep sockaddr/socklen_t ahead of the receive buffer for the
            // same reason as sendto(): a large caller-provided data buffer
            // must not prevent address copy-in/copy-back.
            desc!(4, Out, deref!(5)),
            desc!(5, InOut, fixed!(4)),
            desc!(1, Out, arg!(2)),
        ]
    ),
    entry!(Syscall::Pread as u32, [desc!(1, Out, arg!(2))]),
    entry!(Syscall::Pwrite as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Openat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Tcgetattr as u32, [desc!(1, Out, fixed!(256))]),
    entry!(Syscall::Tcsetattr as u32, [desc!(2, In, fixed!(256))]),
    entry!(Syscall::Ioctl as u32, [desc!(2, InOut, fixed!(256))]),
    entry!(Syscall::Uname as u32, [desc!(0, Out, fixed!(390))]),
    entry!(Syscall::Pipe2 as u32, [desc!(0, Out, fixed!(8))]),
    entry!(
        Syscall::Getrlimit as u32,
        [desc!(1, Out, fixed!(RLIMIT_SIZE))]
    ),
    entry!(
        Syscall::Setrlimit as u32,
        [desc!(1, In, fixed!(RLIMIT_SIZE))]
    ),
    entry!(Syscall::Truncate as u32, [desc!(0, In, cstring!())]),
    entry!(
        Syscall::Fstatat as u32,
        [
            desc!(1, In, cstring!()),
            desc!(2, Out, fixed!(WASM_STAT_SIZE)),
        ]
    ),
    entry!(Syscall::Unlinkat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Mkdirat as u32, [desc!(1, In, cstring!())]),
    entry!(
        Syscall::Renameat as u32,
        [desc!(1, In, cstring!()), desc!(3, In, cstring!()),]
    ),
    entry!(Syscall::Faccessat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Fchmodat as u32, [desc!(1, In, cstring!())]),
    entry!(Syscall::Fchownat as u32, [desc!(1, In, cstring!())]),
    entry!(
        Syscall::Linkat as u32,
        [desc!(1, In, cstring!()), desc!(3, In, cstring!()),]
    ),
    entry!(
        Syscall::Symlinkat as u32,
        [desc!(0, In, cstring!()), desc!(2, In, cstring!()),]
    ),
    entry!(
        Syscall::Readlinkat as u32,
        [desc!(1, In, cstring!()), desc!(2, Out, arg!(3)),]
    ),
    entry!(Syscall::Getrusage as u32, [desc!(1, Out, fixed!(144))]),
    entry!(
        Syscall::Realpath as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, arg!(2)),]
    ),
    entry!(Syscall::Sigsuspend as u32, [desc!(0, In, fixed!(8))]),
    entry!(Syscall::Pathconf as u32, [desc!(0, In, cstring!())]),
    entry!(
        Syscall::Getsockname as u32,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
    entry!(
        Syscall::Getpeername as u32,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
    entry!(extra_syscalls::SYS_LLSEEK, [desc!(3, Out, fixed!(8))]),
    entry!(extra_syscalls::SYS_GETRANDOM, [desc!(0, Out, arg!(1))]),
    entry!(Syscall::Getdents64 as u32, [desc!(1, Out, arg!(2))]),
    entry!(
        Syscall::ClockGetres as u32,
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::ClockNanosleep as u32,
        [desc!(2, In, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        Syscall::Utimensat as u32,
        [
            desc!(1, In, cstring!()),
            desc!(2, In, fixed!(WASM_TIMESPEC_SIZE * 2)),
        ]
    ),
    entry!(
        Syscall::Statfs as u32,
        [
            desc!(0, In, cstring!()),
            desc!(2, Out, fixed!(WASM_STATFS_SIZE)),
        ]
    ),
    entry!(
        Syscall::Fstatfs as u32,
        [desc!(2, Out, fixed!(WASM_STATFS_SIZE))]
    ),
    entry!(
        Syscall::Getresuid as u32,
        [
            desc!(0, Out, fixed!(4)),
            desc!(1, Out, fixed!(4)),
            desc!(2, Out, fixed!(4)),
        ]
    ),
    entry!(
        Syscall::Getresgid as u32,
        [
            desc!(0, Out, fixed!(4)),
            desc!(1, Out, fixed!(4)),
            desc!(2, Out, fixed!(4)),
        ]
    ),
    entry!(
        Syscall::Getgroups as u32,
        [desc!(1, Out, arg!(0, mul 4), no_copy_retval_limit)]
    ),
    entry!(Syscall::Sendmsg as u32, [desc!(1, In, arg!(2))]),
    entry!(Syscall::Recvmsg as u32, [desc!(1, InOut, arg!(2))]),
    entry!(
        Syscall::Wait4 as u32,
        [desc!(1, Out, fixed!(4)), desc!(3, Out, fixed!(32)),]
    ),
    entry!(
        Syscall::Getaddrinfo as u32,
        [desc!(0, In, cstring!()), desc!(1, Out, fixed!(256)),]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGQUEUEINFO,
        [desc!(2, In, fixed!(128))]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGPENDING,
        [desc!(0, Out, fixed!(8))]
    ),
    entry!(
        extra_syscalls::SYS_RT_SIGTIMEDWAIT,
        [
            desc!(0, In, fixed!(8)),
            desc!(1, Out, fixed!(128)),
            desc!(2, In, fixed!(WASM_TIMESPEC_SIZE)),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SIGALTSTACK,
        [
            desc!(0, In, fixed!(STACK_T_SIZE)),
            desc!(1, Out, fixed!(STACK_T_SIZE)),
        ]
    ),
    entry!(
        crate::abi::host_intercepted::SYS_EXECVE,
        [desc!(0, In, cstring!())]
    ),
    // prctl's argument shapes are option-dependent: PR_SET_PDEATHSIG uses
    // arg2 as a scalar signal number, PR_GET_PDEATHSIG uses arg2 as a u32*,
    // PR_SET_NAME/PR_GET_NAME use arg2 as a 16-byte char*. The host marshals
    // these cases dynamically instead of advertising one static pointer shape.
    entry!(
        extra_syscalls::SYS_GETITIMER,
        [desc!(1, Out, fixed!(ITIMERVAL_SIZE))]
    ),
    entry!(
        extra_syscalls::SYS_SETITIMER,
        [
            desc!(1, In, fixed!(ITIMERVAL_SIZE)),
            desc!(2, Out, fixed!(ITIMERVAL_SIZE)),
        ]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_GETPARAM,
        [desc!(1, Out, fixed!(36))]
    ),
    entry!(
        extra_syscalls::SYS_SCHED_RR_GET_INTERVAL,
        [desc!(1, Out, fixed!(WASM_TIMESPEC_SIZE))]
    ),
    entry!(
        extra_syscalls::SYS_PRLIMIT64,
        [desc!(2, In, fixed!(16)), desc!(3, Out, fixed!(16)),]
    ),
    entry!(extra_syscalls::SYS_PPOLL, [desc!(0, InOut, arg!(1, mul 8))]),
    entry!(
        extra_syscalls::SYS_STATX,
        [desc!(1, In, cstring!()), desc!(4, Out, fixed!(256)),]
    ),
    entry!(extra_syscalls::SYS_MKNOD, [desc!(0, In, cstring!())]),
    entry!(extra_syscalls::SYS_MKNODAT, [desc!(1, In, cstring!())]),
    entry!(extra_syscalls::SYS_LCHOWN, [desc!(0, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_TIMER_CREATE,
        [desc!(1, In, fixed!(16)), desc!(2, Out, fixed!(4)),]
    ),
    entry!(
        extra_syscalls::SYS_TIMER_SETTIME,
        [desc!(2, In, fixed!(32)), desc!(3, Out, fixed!(32)),]
    ),
    entry!(
        extra_syscalls::SYS_TIMER_GETTIME,
        [desc!(1, Out, fixed!(32))]
    ),
    entry!(
        extra_syscalls::SYS_MQ_OPEN,
        [desc!(0, In, cstring!()), desc!(3, In, fixed!(32)),]
    ),
    entry!(extra_syscalls::SYS_MQ_UNLINK, [desc!(0, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_MQ_TIMEDSEND,
        [
            desc!(1, In, arg!(2)),
            desc!(4, In, fixed!(WASM_TIMESPEC_SIZE)),
        ]
    ),
    entry!(
        extra_syscalls::SYS_MQ_TIMEDRECEIVE,
        [
            desc!(1, Out, arg!(2)),
            desc!(3, Out, fixed!(4)),
            desc!(4, In, fixed!(WASM_TIMESPEC_SIZE)),
        ]
    ),
    entry!(extra_syscalls::SYS_MQ_NOTIFY, [desc!(1, In, fixed!(16))]),
    entry!(
        extra_syscalls::SYS_MQ_GETSETATTR,
        [desc!(1, In, fixed!(32)), desc!(2, Out, fixed!(32)),]
    ),
    entry!(
        extra_syscalls::SYS_MSGRCV,
        [desc!(1, Out, arg!(2, add 4), copy_retval_add 4)]
    ),
    entry!(extra_syscalls::SYS_MSGSND, [desc!(1, In, arg!(2, add 4))]),
    entry!(extra_syscalls::SYS_MSGCTL, [desc!(2, InOut, fixed!(96))]),
    entry!(extra_syscalls::SYS_SEMOP, [desc!(1, In, arg!(2, mul 6))]),
    entry!(extra_syscalls::SYS_SHMCTL, [desc!(2, InOut, fixed!(88))]),
    entry!(extra_syscalls::SYS_FACCESSAT2, [desc!(1, In, cstring!())]),
    entry!(extra_syscalls::SYS_FCHMODAT2, [desc!(1, In, cstring!())]),
    entry!(
        extra_syscalls::SYS_ACCEPT4,
        [desc!(1, Out, deref!(2)), desc!(2, InOut, fixed!(4)),]
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syscall_arg_descriptors_are_sorted_and_unique() {
        let mut prev = None;
        for entry in SYSCALL_ARG_DESCRIPTORS {
            if let Some(prev) = prev {
                assert!(
                    prev < entry.syscall_number,
                    "descriptor table must be sorted and unique"
                );
            }
            prev = Some(entry.syscall_number);
        }
    }

    #[test]
    fn high_risk_size_adjustments_are_metadata_owned() {
        let poll = find(Syscall::Poll as u32).args[0].size;
        assert_eq!(
            poll,
            SyscallArgSize::Arg {
                arg_index: 1,
                multiplier: 8,
                add: 0,
            }
        );

        let msgrcv = find(extra_syscalls::SYS_MSGRCV).args[0];
        assert_eq!(
            msgrcv.size,
            SyscallArgSize::Arg {
                arg_index: 2,
                multiplier: 1,
                add: 4,
            }
        );
        assert_eq!(msgrcv.copy_retval_add, 4);
        assert!(msgrcv.copy_retval_limit);

        let getgroups = find(Syscall::Getgroups as u32).args[0];
        assert_eq!(
            getgroups.size,
            SyscallArgSize::Arg {
                arg_index: 0,
                multiplier: 4,
                add: 0,
            }
        );
        assert!(!getgroups.copy_retval_limit);

        let pathconf = find(Syscall::Pathconf as u32).args[0];
        assert_eq!(pathconf.arg_index, 0);
        assert_eq!(pathconf.direction, SyscallArgDirection::In);
        assert_eq!(pathconf.size, SyscallArgSize::CString);

        let semop = find(extra_syscalls::SYS_SEMOP).args[0].size;
        assert_eq!(
            semop,
            SyscallArgSize::Arg {
                arg_index: 2,
                multiplier: 6,
                add: 0,
            }
        );

        let lchown = find(extra_syscalls::SYS_LCHOWN).args[0];
        assert_eq!(lchown.arg_index, 0);
        assert_eq!(lchown.direction, SyscallArgDirection::In);
        assert_eq!(lchown.size, SyscallArgSize::CString);

        let sendto = find(Syscall::Sendto as u32).args;
        assert_eq!(sendto[0].arg_index, 4);
        assert_eq!(sendto[1].arg_index, 1);

        let recvfrom = find(Syscall::Recvfrom as u32).args;
        assert_eq!(recvfrom[0].arg_index, 4);
        assert_eq!(recvfrom[1].arg_index, 5);
        assert_eq!(recvfrom[2].arg_index, 1);
    }

    #[test]
    fn nested_pointer_syscalls_stay_out_of_simple_descriptors() {
        assert!(maybe_find(Syscall::Writev as u32).is_none());
        assert!(maybe_find(Syscall::Readv as u32).is_none());
    }

    fn find(syscall_number: u32) -> &'static SyscallArgDescriptor {
        maybe_find(syscall_number).expect("missing syscall arg descriptor")
    }

    fn maybe_find(syscall_number: u32) -> Option<&'static SyscallArgDescriptor> {
        SYSCALL_ARG_DESCRIPTORS
            .iter()
            .find(|entry| entry.syscall_number == syscall_number)
    }
}
