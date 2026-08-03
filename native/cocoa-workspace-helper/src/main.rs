use std::io::{self, Write};

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let frame = std::panic::catch_unwind(|| {
        cocoa_workspace_helper::run_argv(std::env::args_os().skip(1).collect())
    })
    .unwrap_or_else(|_| cocoa_workspace_helper::internal_error_frame());
    let _ = io::stdout().lock().write_all(&frame);
}
