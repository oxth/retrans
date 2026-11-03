use std::path::PathBuf;
use std::process::Command;

#[path = "build_stage.rs"]
mod build_stage;

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
/// `ggml-cpu-*.dll` per CPU variant. Mirror them, plus the VC++ runtime DLLs they import (they are
/// built with the default dynamic CRT, /MD), into `llama-dlls/`, which the Windows bundle installs
/// next to the exe (see tauri.windows.conf.json), so a clean machine needs no VC++ redistributable.
/// Only changed DLLs are copied and stale ones removed, so an unchanged build leaves the folder
/// (and the bundle inputs) alone.
fn stage_llama_dlls_on_windows() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    println!("cargo:rerun-if-env-changed=DEP_LLAMA_BACKENDS_DIR");
    println!("cargo:rerun-if-changed=build_stage.rs");
    // Set by llama-cpp-sys-2's build script (`cargo:backends_dir=<OUT_DIR>/backends`).
    let backends = PathBuf::from(
        std::env::var("DEP_LLAMA_BACKENDS_DIR")
            .expect("DEP_LLAMA_BACKENDS_DIR not set: is llama-cpp-sys-2 a direct dependency with dynamic-backends?"),
    );
    // llama-cpp-sys-2 installs the shared libraries to `<OUT_DIR>/bin` on Windows.
    let shared = backends.parent().expect("backends dir has a parent").join("bin");
    for dir in [&shared, &backends] {
        if dir.is_dir() {
            println!("cargo:rerun-if-changed={}", dir.display());
        } else {
            println!("cargo:warning=llama.cpp DLL dir {} is missing", dir.display());
        }
    }

    let crt: Vec<PathBuf> = match vc_runtime_dir() {
        Some(dir) => build_stage::VC_CRT_DLLS.iter().map(|n| dir.join(n)).collect(),
        None => {
            let msg = "VC++ runtime DLLs (msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll) not found in \
                       %VCToolsRedistDir%, the Visual Studio install or System32; the app won't start on a \
                       machine without the VC++ redistributable";
            println!("cargo:warning={msg}");
            if std::env::var("PROFILE").as_deref() == Ok("release") {
                panic!("{msg}");
            }
            Vec::new()
        }
    };

    let dest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("llama-dlls");
    let report = build_stage::sync_dlls(&[&shared, &backends], &crt, &dest).expect("stage llama.cpp DLLs");
    if report.found == 0 {
        panic!("no llama.cpp DLLs found in {} or {}", shared.display(), backends.display());
    }
}

/// The x64 VC++ runtime folder to ship from: `%VCToolsRedistDir%`, `%VCINSTALLDIR%`, the newest
/// Visual Studio with the C++ tools (vswhere), then System32 (see build_stage::find_vc_crt).
fn vc_runtime_dir() -> Option<PathBuf> {
    println!("cargo:rerun-if-env-changed=VCToolsRedistDir");
    println!("cargo:rerun-if-env-changed=VCINSTALLDIR");
    let env_dir = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let found = build_stage::find_vc_crt(
        env_dir("VCToolsRedistDir"),
        env_dir("VCINSTALLDIR"),
        vswhere_install_dir(),
        env_dir("SystemRoot").map(|r| r.join("System32")),
    );
    if let Some(dir) = &found {
        println!("cargo:rerun-if-changed={}", dir.display());
    }
    found
}

fn vswhere_install_dir() -> Option<PathBuf> {
    let base = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from)?;
    let vswhere = base.join("Microsoft Visual Studio").join("Installer").join("vswhere.exe");
    let out = Command::new(vswhere)
        .args(["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"])
        .args(["-property", "installationPath"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let path = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}
