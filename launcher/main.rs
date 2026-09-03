#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    let root = exe.parent().expect("install dir").to_path_buf();
    let node = root.join("node").join("node.exe");
    let script = root.join("start.js");
    if !node.exists() || !script.exists() {
        let _ = Command::new("mshta")
            .arg("javascript:alert('DSH 启动失败：缺少 node/node.exe 或 start.js');close()")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        std::process::exit(1);
    }

    let mut path = node.parent().unwrap().display().to_string();
    if let Ok(old) = std::env::var("PATH") {
        path.push(';');
        path.push_str(&old);
    }

    let data = PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("DSH").join("data");

    let status = Command::new(&node)
        .arg(&script)
        .current_dir(&root)
        .env("PATH", path)
        .env("DSH_VERSIONS_DATA", data)
        .creation_flags(CREATE_NO_WINDOW)
        .status();

    if let Err(error) = status {
        let msg = format!("javascript:alert('DSH 启动失败：{error}');close()");
        let _ = Command::new("mshta").arg(msg).spawn();
        std::process::exit(1);
    }
}
