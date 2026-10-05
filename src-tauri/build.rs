fn main() {
    // server 模式不需要生成 Tauri 上下文，也就不需要 tauri-build。
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
