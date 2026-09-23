//! Owns the backend child. The session token stays in this process.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Authenticating,
    Ready,
    Unavailable,
    Failed,
    Stopping,
    Stopped,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::Authenticating => "authenticating",
            Phase::Ready => "ready",
            Phase::Unavailable => "unavailable",
            Phase::Failed => "failed",
            Phase::Stopping => "stopping",
            Phase::Stopped => "stopped",
        }
    }
}

pub struct Session {
    pub phase: Phase,
    pub detail: String,
    pub port: u16,
    pub token: Vec<u8>,
    child: Option<Child>,
    stdin: Option<std::process::ChildStdin>,
}

impl Session {
    pub fn new() -> Self {
        Self {
            phase: Phase::Stopped,
            detail: String::new(),
            port: 0,
            token: Vec::new(),
            child: None,
            stdin: None,
        }
    }
}

pub type SharedSession = Mutex<Session>;

pub fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundled = exe.parent()?.join("docxeditor-backend");
    if bundled.is_file() {
        return Some(bundled);
    }
    None
}

pub fn ready_mac(token: &[u8], port: u16) -> String {
    let mut mac = HmacSha256::new_from_slice(token).expect("hmac key");
    mac.update(format!("ready-v1\n{port}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// A listener that only answers HTTP is not this child.
pub fn accept_ready(line: &str, token: &[u8]) -> Option<u16> {
    let mut parts = line.trim().split(' ');
    if parts.next()? != "READY" || parts.next()? != "v1" {
        return None;
    }
    let port_text = parts.next()?;
    let mac = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let port: u16 = port_text.parse().ok()?;
    if port_text != port.to_string() {
        return None;
    }
    let expected = ready_mac(token, port);
    if mac.len() != expected.len() || !constant_eq(mac.as_bytes(), expected.as_bytes()) {
        return None;
    }
    Some(port)
}

fn constant_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

pub fn note_if_exited(session: &mut Session) -> bool {
    if session.phase != Phase::Ready {
        return false;
    }
    let exited = session
        .child
        .as_mut()
        .and_then(|child| child.try_wait().ok())
        .flatten()
        .is_some();
    if !exited {
        return false;
    }
    session.phase = Phase::Unavailable;
    session.detail = "The backend stopped.".to_string();
    session.token.clear();
    session.port = 0;
    session.child = None;
    drop(session.stdin.take());
    true
}

pub fn stop(session: &mut Session) {
    session.phase = Phase::Stopping;
    drop(session.stdin.take());
    if let Some(child) = session.child.as_mut() {
        let pid = child.id();
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        let started = Instant::now();
        loop {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            if started.elapsed() > Duration::from_secs(2) {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    session.child = None;
    session.token.clear();
    session.port = 0;
    session.phase = Phase::Stopped;
}

pub fn start(session: &mut Session) -> Result<(), String> {
    if matches!(session.phase, Phase::Starting | Phase::Authenticating | Phase::Ready) {
        return Ok(());
    }
    if session.child.is_some() {
        stop(session);
    }
    let path = sidecar_path().ok_or_else(|| "The bundled backend is missing.".to_string())?;
    session.phase = Phase::Starting;
    session.detail.clear();
    let token: [u8; 32] = rand_token();
    let mut command = Command::new(&path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command.spawn().map_err(|_| "The bundled backend did not start.".to_string())?;
    let mut stdin = child.stdin.take().ok_or_else(|| "The backend pipe could not be opened.".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "The backend pipe could not be opened.".to_string())?;
    let line = format!("v1 {}\n", hex::encode(token));
    stdin.write_all(line.as_bytes()).map_err(|_| "The backend pipe could not be opened.".to_string())?;
    stdin.flush().map_err(|_| "The backend pipe could not be opened.".to_string())?;
    session.phase = Phase::Authenticating;
    let ready = read_ready(stdout, &token);
    match ready {
        Some(port) => {
            session.port = port;
            session.token = token.to_vec();
            session.child = Some(child);
            session.stdin = Some(stdin);
            session.phase = Phase::Ready;
            session.detail.clear();
            Ok(())
        }
        None => {
            let pid = child.id();
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            let _ = child.wait();
            session.phase = Phase::Failed;
            session.detail = "The backend did not authenticate.".to_string();
            session.token.clear();
            Err(session.detail.clone())
        }
    }
}

fn read_ready(stdout: std::process::ChildStdout, token: &[u8; 32]) -> Option<u16> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx.recv_timeout(Duration::from_secs(20)).ok()?;
    accept_ready(&line, token)
}

fn rand_token() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system random");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_json_is_not_a_handshake() {
        let token = [7u8; 32];
        assert!(accept_ready("{\"status\":\"ok\"}\n", &token).is_none());
        let port = 4242u16;
        let mac = ready_mac(&token, port);
        let line = format!("READY v1 {port} {mac}\n");
        assert_eq!(accept_ready(&line, &token), Some(port));
        assert!(accept_ready(&line, &[8u8; 32]).is_none());
    }
}
