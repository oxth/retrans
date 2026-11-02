use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    link_clang_runtime_on_macos();
    // Before `tauri_build::build()`: it resolves `bundle.resources` (tauri.windows.conf.json
    // maps `llama-dlls/`), so the folder must already be filled.
    stage_llama_dlls_on_windows();
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
    let Some(dir) = clang_runtime_dir() else {
        println!("cargo:warning=couldn't ask clang for its runtime dir; can't link compiler-rt for llama.cpp Metal");
        return;
    };
    if !dir.is_dir() {
        println!("cargo:warning=clang runtime dir {} is missing; can't link compiler-rt for llama.cpp Metal", dir.display());
        return;
    }
    if !dir.join("libclang_rt.osx.a").is_file() {
        println!("cargo:warning=libclang_rt.osx.a not found in {}; can't link compiler-rt for llama.cpp Metal", dir.display());
        return;
    }
    println!("cargo:rustc-link-search=native={}", dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}

/// `clang --print-runtime-dir`, preferring the active toolchain's clang (`xcrun --find clang`)
/// over whatever `clang` is first on PATH.
fn clang_runtime_dir() -> Option<PathBuf> {
    let xcrun_clang = Command::new("xcrun")
        .args(["--find", "clang"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let candidates = xcrun_clang.into_iter().chain(std::iter::once("clang".to_string()));
    for clang in candidates {
        let Ok(out) = Command::new(&clang).arg("--print-runtime-dir").output() else { continue };
        let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    None
}

/// Windows builds llama.cpp with `dynamic-backends`: `llama.dll`/`ggml*.dll` plus one
/// `ggml-cpu-*.dll` per CPU variant. Copy them all into `llama-dlls/`, which the Windows
/// bundle installs next to the exe (see tauri.windows.conf.json).
fn stage_llama_dlls_on_windows() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    println!("cargo:rerun-if-env-changed=DEP_LLAMA_BACKENDS_DIR");
    // Set by llama-cpp-sys-2's build script (`cargo:backends_dir=<OUT_DIR>/backends`).
    let backends = PathBuf::from(
        std::env::var("DEP_LLAMA_BACKENDS_DIR")
            .expect("DEP_LLAMA_BACKENDS_DIR not set: is llama-cpp-sys-2 a direct dependency with dynamic-backends?"),
    );
    // llama-cpp-sys-2 installs the shared libraries to `<OUT_DIR>/bin` on Windows.
    let shared = backends.parent().expect("backends dir has a parent").join("bin");

    let dest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("llama-dlls");
    let _ = std::fs::remove_dir_all(&dest); // drop DLLs left over from an older build
    std::fs::create_dir_all(&dest).expect("create llama-dlls");
    let mut copied = 0;
    for dir in [&shared, &backends] {
        copied += copy_dlls(dir, &dest);
    }
    if copied == 0 {
        panic!("no llama.cpp DLLs found in {} or {}", shared.display(), backends.display());
    }
}

fn copy_dlls(from: &Path, to: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(from) else {
        println!("cargo:warning=llama.cpp DLL dir {} is missing", from.display());
        return 0;
    };
    let mut n = 0;
    for path in entries.filter_map(|e| e.ok().map(|e| e.path())) {
        let is_dll = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dll"));
        if is_dll && path.is_file() {
            std::fs::copy(&path, to.join(path.file_name().unwrap())).expect("copy llama.cpp DLL");
            n += 1;
        }
    }
    n
}
