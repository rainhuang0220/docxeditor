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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    pub generation: u64,
    /// True while spawn/bootstrap runs before the child is stored in `child`.
    launching: bool,
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
            generation: 0,
            launching: false,
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

fn terminate_group(mut child: Child, stdin: Option<std::process::ChildStdin>) {
    drop(stdin);
    let pid = child.id();
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    let started = Instant::now();
    loop {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        if started.elapsed() >= Duration::from_secs(2) {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn fail(shared: &SharedSession, generation: u64, detail: &str) {
    let owned = {
        let mut session = shared.lock().expect("session");
        if session.generation != generation {
            return;
        }
        session.phase = Phase::Failed;
        session.detail = detail.to_string();
        session.port = 0;
        session.token.clear();
        session.launching = false;
        let child = session.child.take();
        let stdin = session.stdin.take();
        child.map(|child| (child, stdin))
    };
    if let Some((child, stdin)) = owned {
        terminate_group(child, stdin);
    }
}

/// App setup schedules an async start; surface Starting before the first status poll.
pub fn mark_startup_scheduled(shared: &SharedSession) {
    let mut session = shared.lock().expect("session");
    if session.phase == Phase::Stopped {
        session.generation = session.generation.wrapping_add(1);
        session.phase = Phase::Starting;
        session.detail.clear();
        session.launching = false;
    }
}

fn startup_already_owned(session: &Session) -> bool {
    matches!(session.phase, Phase::Authenticating | Phase::Ready)
        || session.child.is_some()
        || session.launching
}

pub fn stop(shared: &SharedSession) {
    let (generation, child) = {
        let mut session = shared.lock().expect("session");
        session.generation = session.generation.wrapping_add(1);
        session.phase = Phase::Stopping;
        session.launching = false;
        let generation = session.generation;
        let child = session.child.take();
        let stdin = session.stdin.take();
        session.token.clear();
        session.port = 0;
        (generation, child.map(|child| (child, stdin)))
    };
    if let Some((child, stdin)) = child {
        terminate_group(child, stdin);
    }
    let mut session = shared.lock().expect("session");
    if session.generation == generation {
        session.phase = Phase::Stopped;
        session.token.clear();
        session.port = 0;
        session.launching = false;
    }
}

pub fn start(shared: &SharedSession) -> Result<(), String> {
    let Some(path) = sidecar_path() else {
        let generation = {
            let mut session = shared.lock().expect("session");
            if session.phase != Phase::Starting {
                session.generation = session.generation.wrapping_add(1);
            }
            session.launching = false;
            session.generation
        };
        fail(shared, generation, "The bundled backend is missing.");
        return Err("The bundled backend is missing.".to_string());
    };
    start_at(shared, &path, PACKAGED_READY_TIMEOUT)
}

/// Cold onefile READY ~24–34s idle; under load can exceed 45s. Keep margin while UI shows progress.
pub const PACKAGED_READY_TIMEOUT: Duration = Duration::from_secs(75);

pub fn start_at(shared: &SharedSession, path: &std::path::Path, ready_timeout: Duration) -> Result<(), String> {
    {
        let session = shared.lock().expect("session");
        if startup_already_owned(&session) {
            return Ok(());
        }
        let occupied = session.child.is_some();
        drop(session);
        if occupied {
            stop(shared);
        }
    }
    let generation = {
        let mut session = shared.lock().expect("session");
        if startup_already_owned(&session) {
            return Ok(());
        }
        if session.phase != Phase::Starting {
            session.generation = session.generation.wrapping_add(1);
            session.phase = Phase::Starting;
            session.detail.clear();
            session.port = 0;
            session.token.clear();
        }
        session.launching = true;
        session.generation
    };
    let token = rand_token();
    let mut command = Command::new(path);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            fail(shared, generation, "The bundled backend did not start.");
            return Err("The bundled backend did not start.".to_string());
        }
    };
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            terminate_group(child, None);
            fail(shared, generation, "The backend pipe could not be opened.");
            return Err("The backend pipe could not be opened.".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_group(child, Some(stdin));
            fail(shared, generation, "The backend pipe could not be opened.");
            return Err("The backend pipe could not be opened.".to_string());
        }
    };
    let line = format!("v1 {}\n", hex::encode(token));
    if stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush()).is_err() {
        terminate_group(child, Some(stdin));
        fail(shared, generation, "The backend pipe could not be opened.");
        return Err("The backend pipe could not be opened.".to_string());
    }
    // Own the child before blocking on READY so stop/retry can reap it mid-auth.
    {
        let mut session = shared.lock().expect("session");
        if session.generation != generation {
            drop(session);
            terminate_group(child, Some(stdin));
            return Err("The backend startup was replaced.".to_string());
        }
        session.phase = Phase::Authenticating;
        session.child = Some(child);
        session.stdin = Some(stdin);
        session.launching = false;
    }
    let port = match read_ready(stdout, &token, ready_timeout) {
        Some(port) => port,
        None => {
            fail(shared, generation, "The backend did not authenticate.");
            return Err("The backend did not authenticate.".to_string());
        }
    };
    if !still_current(shared, generation) {
        // stop() already reaped this generation's child when it bumped ownership.
        return Err("The backend startup was replaced.".to_string());
    }
    if !probe_health(port, &token) {
        fail(shared, generation, "The backend did not become ready.");
        return Err("The backend did not become ready.".to_string());
    }
    let mut session = shared.lock().expect("session");
    if session.generation != generation {
        return Err("The backend startup was replaced.".to_string());
    }
    session.port = port;
    session.token = token.to_vec();
    session.phase = Phase::Ready;
    session.detail.clear();
    session.launching = false;
    Ok(())
}

fn still_current(shared: &SharedSession, generation: u64) -> bool {
    shared.lock().expect("session").generation == generation
}

fn probe_health(port: u16, token: &[u8]) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
        hex::encode(token)
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0u8; 64];
    let size = match stream.read(&mut buffer) {
        Ok(size) => size,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&buffer[..size]);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}

fn read_ready(stdout: std::process::ChildStdout, token: &[u8; 32], timeout: Duration) -> Option<u16> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx.recv_timeout(timeout).ok()?;
    if line.is_empty() {
        return None;
    }
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
    fn packaged_ready_timeout_covers_cold_onefile() {
        // Measured idle cold READY ~24–34s; under load observed up to ~61s.
        // 45s still marked Offline on a contended relaunch.
        assert!(PACKAGED_READY_TIMEOUT > Duration::from_secs(61));
        assert!(PACKAGED_READY_TIMEOUT <= Duration::from_secs(90));
    }

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

    fn script(body: &str) -> (TempDir, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "docxeditor-supervisor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("child.py");
        std::fs::write(&path, format!("#!/usr/bin/env python3\n{body}")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }
        (TempDir(dir), path)
    }

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn py_quote(path: &std::path::Path) -> String {
        format!("{:?}", path.display().to_string())
    }

    /// Isolation for parallel `cargo test` threads: pid alone collides in-process.
    fn unique_temp(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn wait_for_path(path: &std::path::Path, deadline: Instant, label: &str) {
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "{label} never appeared at {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn alive(pid: u32) -> bool {
        if unsafe { libc::kill(pid as i32, 0) } != 0 {
            return false;
        }
        let output = Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output();
        let text = output.ok().and_then(|output| String::from_utf8(output.stdout).ok()).unwrap_or_default();
        let stat = text.trim();
        !stat.is_empty() && !stat.starts_with('Z')
    }

    #[test]
    fn exit_before_ready_is_reaped() {
        let pidfile = unique_temp("docxeditor-pid");
        let (_dir, path) = script(&format!(
            "import os\nopen({:?}, 'w').write(str(os.getpid()))\nraise SystemExit(3)\n",
            pidfile
        ));
        let shared = Mutex::new(Session::new());
        let error = start_at(&shared, &path, Duration::from_secs(8)).unwrap_err();
        assert!(error.contains("did not authenticate") || error.contains("pipe"));
        let session = shared.lock().unwrap();
        assert_eq!(session.phase, Phase::Failed);
        assert!(session.token.is_empty());
        assert_eq!(session.port, 0);
        assert!(session.child.is_none());
        drop(session);
        wait_for_path(&pidfile, Instant::now() + Duration::from_secs(5), "exit pidfile");
        let pid: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        assert!(!alive(pid));
        let _ = std::fs::remove_file(pidfile);
    }

    #[test]
    fn forged_ready_is_reaped() {
        let pidfile = unique_temp("docxeditor-forged");
        let (_dir, path) = script(&format!(
            "import os, time\nopen({:?}, 'w').write(str(os.getpid()))\nprint('READY v1 9 ' + ('ab' * 32), flush=True)\ntime.sleep(30)\n",
            pidfile
        ));
        let shared = Mutex::new(Session::new());
        let started = Instant::now();
        let error = start_at(&shared, &path, Duration::from_secs(8)).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(12), "{error}");
        let session = shared.lock().unwrap();
        assert_eq!(session.phase, Phase::Failed);
        assert!(session.token.is_empty());
        assert!(session.child.is_none());
        drop(session);
        wait_for_path(&pidfile, Instant::now() + Duration::from_secs(5), "forged pidfile");
        let pid: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        assert!(!alive(pid));
        let _ = std::fs::remove_file(pidfile);
    }

    #[test]
    fn sigterm_ignored_is_killed() {
        let pidfile = unique_temp("docxeditor-ign");
        let (_dir, path) = script(&format!(
            "import os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nchild = os.fork()\nif child == 0:\n    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n    time.sleep(30)\n    raise SystemExit\nopen({}, 'w').write(str(os.getpid()) + '\\n' + str(child))\ntime.sleep(30)\n",
            py_quote(&pidfile)
        ));
        use std::os::unix::process::CommandExt;
        let child = Command::new(&path).process_group(0).spawn().unwrap();
        wait_for_path(&pidfile, Instant::now() + Duration::from_secs(15), "sigterm pidfile");
        let started = Instant::now();
        terminate_group(child, None);
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_secs(2), "killed before SIGKILL: {elapsed:?}");
        assert!(elapsed < Duration::from_secs(5), "cleanup was not bounded: {elapsed:?}");
        let text = std::fs::read_to_string(&pidfile).unwrap();
        for line in text.lines() {
            let pid: u32 = line.trim().parse().unwrap();
            assert!(!alive(pid), "orphan {pid}");
        }
        let _ = std::fs::remove_file(&pidfile);
    }

    #[test]
    fn authenticating_is_visible_and_retry_uses_a_new_token() {
        let barrier = unique_temp("docxeditor-barrier");
        let release = unique_temp("docxeditor-release");
        let (_dir, path) = script(&format!(
            "import os, time, sys\nline = sys.stdin.readline()\nopen({}, 'w').write('up')\nwhile not os.path.exists({}):\n    time.sleep(0.01)\nraise SystemExit(0)\n",
            py_quote(&barrier),
            py_quote(&release),
        ));
        let shared = std::sync::Arc::new(Mutex::new(Session::new()));
        let worker = shared.clone();
        let binary = path.clone();
        let handle = std::thread::spawn(move || start_at(&worker, &binary, Duration::from_secs(8)));
        let deadline = Instant::now() + Duration::from_secs(15);
        while !barrier.exists() {
            assert!(
                Instant::now() < deadline,
                "child did not reach the barrier\n{}",
                std::fs::read_to_string(&path).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut saw = false;
        while Instant::now() < deadline {
            if shared.lock().unwrap().phase == Phase::Authenticating {
                saw = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(saw, "startup phase was not visible");
        std::fs::write(&release, "go").unwrap();
        let error = handle.join().unwrap().unwrap_err();
        assert!(error.contains("did not authenticate"));
        let session = shared.lock().unwrap();
        assert_eq!(session.phase, Phase::Failed);
        assert!(session.child.is_none());
        drop(session);

        let log = unique_temp("docxeditor-tokens");
        let (_dir, server) = script(&format!(
            "import hashlib, hmac, os, socket, sys, time\nline = sys.stdin.readline().strip().split()\ntoken = bytes.fromhex(line[1])\nopen({:?}, 'a').write(token.hex() + '\\n')\nsock = socket.socket(); sock.bind(('127.0.0.1', 0)); sock.listen(1)\nport = sock.getsockname()[1]\nmac = hmac.new(token, f'ready-v1\\n{{port}}'.encode(), hashlib.sha256).hexdigest()\nprint(f'READY v1 {{port}} {{mac}}', flush=True)\nconn, _ = sock.accept()\ndata = b''\nwhile b'\\r\\n\\r\\n' not in data:\n    data += conn.recv(4096)\nconn.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK')\ntime.sleep(30)\n",
            log
        ));
        let shared = Mutex::new(Session::new());
        start_at(&shared, &server, Duration::from_secs(8)).unwrap();
        let first = shared.lock().unwrap().token.clone();
        stop(&shared);
        assert!(shared.lock().unwrap().token.is_empty());
        assert_eq!(shared.lock().unwrap().phase, Phase::Stopped);
        start_at(&shared, &server, Duration::from_secs(8)).unwrap();
        let second = shared.lock().unwrap().token.clone();
        stop(&shared);
        assert_ne!(first, second);
        let recorded = std::fs::read_to_string(&log).unwrap();
        assert!(recorded.contains(&hex::encode(&first)));
        assert!(recorded.contains(&hex::encode(&second)));
        assert!(shared.lock().unwrap().token.is_empty());
        let _ = std::fs::remove_file(&log);
        let _ = std::fs::remove_file(&barrier);
        let _ = std::fs::remove_file(&release);
    }

    #[test]
    fn health_without_mac_is_not_ready() {
        let (_dir, path) = script(
            "import hashlib, hmac, sys, time\nline = sys.stdin.readline().strip().split()\ntoken = bytes.fromhex(line[1])\nmac = hmac.new(token, b'ready-v1\\n1', hashlib.sha256).hexdigest()\nprint(f'READY v1 1 {mac}', flush=True)\ntime.sleep(30)\n",
        );
        let shared = Mutex::new(Session::new());
        let error = start_at(&shared, &path, Duration::from_secs(8)).unwrap_err();
        assert!(error.contains("did not become ready"));
        let session = shared.lock().unwrap();
        assert_eq!(session.phase, Phase::Failed);
        assert!(session.token.is_empty());
        assert_eq!(session.port, 0);
        assert!(session.child.is_none());
    }

    #[test]
    fn scheduled_startup_is_starting_before_spawn() {
        let shared = Mutex::new(Session::new());
        assert_eq!(shared.lock().unwrap().phase, Phase::Stopped);
        mark_startup_scheduled(&shared);
        assert_eq!(shared.lock().unwrap().phase, Phase::Starting);
        // Scheduled Starting must not block the real spawn (no owned child yet).
        let pidfile = unique_temp("docxeditor-sched");
        let (_dir, path) = script(&format!(
            "import os\nopen({:?}, 'w').write(str(os.getpid()))\nraise SystemExit(3)\n",
            pidfile
        ));
        let error = start_at(&shared, &path, Duration::from_secs(8)).unwrap_err();
        assert!(error.contains("did not authenticate") || error.contains("pipe"));
        assert_eq!(shared.lock().unwrap().phase, Phase::Failed);
        stop(&shared);
        assert_eq!(shared.lock().unwrap().phase, Phase::Stopped);
        let _ = std::fs::remove_file(pidfile);
    }

    #[test]
    fn concurrent_retry_while_blocked_before_ready_keeps_one_sidecar() {
        let pid_log = unique_temp("docxeditor-retry-pids");
        let barrier = unique_temp("docxeditor-retry-barrier");
        let release = unique_temp("docxeditor-retry-release");

        // Fake sidecar: consume bootstrap, record pid, park before READY until release.
        // Keep indented blocks on the same physical line after \\n — Rust string
        // continuations strip leading whitespace on the next source line.
        let (_dir, path) = script(&format!(
            "import hashlib, hmac, os, socket, sys, time\n\
line = sys.stdin.readline().strip().split()\n\
token = bytes.fromhex(line[1])\n\
open({pid}, 'a').write(str(os.getpid()) + '\\n')\n\
open({barrier}, 'w').write('blocked')\n\
while not os.path.exists({release}):\n    time.sleep(0.01)\n\
sock = socket.socket(); sock.bind(('127.0.0.1', 0)); sock.listen(1)\n\
port = sock.getsockname()[1]\n\
mac = hmac.new(token, f'ready-v1\\n{{port}}'.encode(), hashlib.sha256).hexdigest()\n\
print(f'READY v1 {{port}} {{mac}}', flush=True)\n\
conn, _ = sock.accept()\n\
data = b''\n\
while b'\\r\\n\\r\\n' not in data:\n    data += conn.recv(4096)\n\
conn.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK')\n\
time.sleep(30)\n",
            pid = py_quote(&pid_log),
            barrier = py_quote(&barrier),
            release = py_quote(&release),
        ));

        let shared = std::sync::Arc::new(Mutex::new(Session::new()));
        let worker = shared.clone();
        let binary = path.clone();
        let first = std::thread::spawn(move || start_at(&worker, &binary, Duration::from_secs(8)));

        let deadline = Instant::now() + Duration::from_secs(15);
        while !barrier.exists() {
            if first.is_finished() {
                let err = first.join().unwrap().unwrap_err();
                panic!(
                    "first start ended before barrier: {err}\nscript:\n{}",
                    std::fs::read_to_string(&path).unwrap_or_default()
                );
            }
            assert!(
                Instant::now() < deadline,
                "first sidecar never reached the pre-READY barrier\nphase={:?}\nscript:\n{}",
                shared.lock().unwrap().phase,
                std::fs::read_to_string(&path).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let blocked_generation = {
            let session = shared.lock().unwrap();
            assert_eq!(session.phase, Phase::Authenticating);
            assert!(
                session.child.is_some(),
                "authenticating sidecar must be owned so stop/retry can reap it"
            );
            session.generation
        };

        // Count stops completed (not mere thread spawn) so release cannot race a
        // still-current Authenticating generation into a lucky Ready publish.
        let stops_done = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let retry_a = {
            let shared = shared.clone();
            let path = path.clone();
            let stops_done = stops_done.clone();
            std::thread::spawn(move || {
                stop(&shared);
                stops_done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                start_at(&shared, &path, Duration::from_secs(8))
            })
        };
        let retry_b = {
            let shared = shared.clone();
            let path = path.clone();
            let stops_done = stops_done.clone();
            std::thread::spawn(move || {
                stop(&shared);
                stops_done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                start_at(&shared, &path, Duration::from_secs(8))
            })
        };

        let stop_deadline = Instant::now() + Duration::from_secs(5);
        while stops_done.load(std::sync::atomic::Ordering::SeqCst) < 1 {
            assert!(
                Instant::now() < stop_deadline,
                "concurrent retries never superseded the blocked generation"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            shared.lock().unwrap().generation > blocked_generation,
            "stop must bump generation before release"
        );
        // Unblock any still-parked sidecars only after ownership moved: an old
        // READY line must not publish Ready; the new generation stays authoritative.
        std::fs::write(&release, "go").unwrap();

        let first_result = first.join().unwrap();
        let retry_a_result = retry_a.join().unwrap();
        let retry_b_result = retry_b.join().unwrap();
        assert!(
            first_result.is_err(),
            "old generation must not publish Ready after concurrent retry"
        );
        let first_err = first_result.unwrap_err();
        assert!(
            first_err.contains("replaced") || first_err.contains("did not authenticate"),
            "unexpected old-generation error: {first_err}"
        );
        assert!(
            retry_a_result.is_ok() || retry_b_result.is_ok(),
            "at least one retry must become Ready; a={retry_a_result:?} b={retry_b_result:?}"
        );

        let session = shared.lock().unwrap();
        assert_eq!(session.phase, Phase::Ready, "detail={}", session.detail);
        assert!(session.child.is_some());
        let owner_generation = session.generation;
        let owner_pid = session.child.as_ref().map(|child| child.id());
        assert!(
            owner_generation > blocked_generation,
            "new generation must remain authoritative (blocked={blocked_generation}, owner={owner_generation})"
        );
        drop(session);

        let recorded: Vec<u32> = std::fs::read_to_string(&pid_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect();
        assert!(!recorded.is_empty(), "expected at least one spawned sidecar");
        let live: Vec<u32> = recorded.into_iter().filter(|pid| alive(*pid)).collect();
        assert_eq!(
            live.len(),
            1,
            "retry during Authenticating must leave exactly one live sidecar, got {live:?}"
        );
        assert_eq!(Some(live[0]), owner_pid);

        stop(&shared);
        assert_eq!(shared.lock().unwrap().phase, Phase::Stopped);
        assert!(shared.lock().unwrap().child.is_none());
        assert!(!alive(live[0]), "quit/stop must reap the owned process group");
        let _ = std::fs::remove_file(&pid_log);
        let _ = std::fs::remove_file(&barrier);
        let _ = std::fs::remove_file(&release);
    }
}
