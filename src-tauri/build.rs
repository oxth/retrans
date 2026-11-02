fn main() {
    link_clang_runtime_on_macos();
    tauri_build::build()
}

/// llama.cpp's Metal backend uses `@available(...)` checks, which compile to calls to
/// `___isPlatformVersionAtLeast` when the deployment target is older than the checked OS
/// (`tauri build` sets `MACOSX_DEPLOYMENT_TARGET`). That symbol lives in clang's compiler-rt,
/// which rustc doesn't link (it passes `-nodefaultlibs`), so link it explicitly.
fn link_clang_runtime_on_macos() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(out) = std::process::Command::new("clang").arg("--print-runtime-dir").output() else {
        println!("cargo:warning=clang not found; can't link compiler-rt for llama.cpp Metal");
        return;
    };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && std::path::Path::new(&dir).join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
