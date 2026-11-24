use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};
use tauri::Url;

#[cfg(test)]
mod tests;

pub fn directory() -> Result<PathBuf, String> {
    let missing = "Could not find hub/server.js. Set CCD_HUB_DIR to the existing hub folder.";
    let is_hub = |dir: &Path| dir.join("server.js").is_file() && dir.join("ptyhost.js").is_file();
    if let Some(path) = env::var_os("CCD_HUB_DIR") {
        let path = PathBuf::from(path);
        return if path.is_absolute() && is_hub(&path) {
            Ok(path)
        } else {
            Err(missing.into())
        };
    }
    let executable = env::current_exe().ok();
    let cwd = env::current_dir().ok();
    executable
        .as_deref()
        .and_then(Path::parent)
        .iter()
        .copied()
        .chain(cwd.as_deref())
        .flat_map(Path::ancestors)
        .flat_map(|dir| [dir.join("hub"), dir.to_owned()])
        .find(|dir| is_hub(dir))
        .ok_or_else(|| missing.into())
}

pub fn token(dir: &Path, base: &Url) -> Option<String> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 1024
            && value.bytes().all(|byte| byte.is_ascii_graphic())
    };
    if let Ok(raw) = fs::read_to_string(dir.join(".token")) {
        if valid(raw.trim()) {
            return Some(raw.trim().to_owned());
        }
    }
    let raw = fs::read_to_string(dir.join("url.txt")).ok()?;
    let url = Url::parse(raw.trim()).ok()?;
    if url.origin() != base.origin()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.query_pairs()
        .find(|(key, value)| key == "t" && valid(value))
        .map(|(_, value)| value.into_owned())
}

pub fn start(dir: &Path, port: u16) -> Result<Child, String> {
    let node = env::var_os("PATH")
        .iter()
        .flat_map(env::split_paths)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|path| path.is_file())
        .ok_or("System Node.js was not found on PATH. Install Node.js and reopen the launcher.")?;
    let mut command = Command::new(node);
    command
        .arg("--use-system-ca")
        .arg(dir.join("server.js"))
        .current_dir(dir)
        .env("CCD_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(DETACHED_PROCESS);
    }
    command
        .spawn()
        .map_err(|error| format!("Could not start Node.js ({error})."))
}
