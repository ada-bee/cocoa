use std::io::{self, Write};

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let recovery_args = args.clone();
    let frame = std::panic::catch_unwind(|| cocoa_workspace_helper::run_argv(args))
        .unwrap_or_else(|_| cocoa_workspace_helper::internal_error_frame_for_argv(&recovery_args));
    let _ = io::stdout().lock().write_all(&frame);
}
