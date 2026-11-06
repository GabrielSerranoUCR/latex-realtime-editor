use std::{
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::{fs, process::Command, sync::Semaphore};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Debug)]
pub struct CompileResult {
    pub success: bool,
    pub pdf: Option<Vec<u8>>,
    pub log: String,
    pub diagnostics: Vec<Diagnostic>,
    pub duration: Duration,
}

/// Compiles LaTeX projects by running the Tectonic engine in a throwaway directory.
///
/// A semaphore bounds how many compiles run at once (the "worker pool"). Tectonic is invoked
/// as an external process so it can be sandboxed (container, seccomp, resource limits) and so a
/// misbehaving document can be killed on timeout without taking the server down.
pub struct Compiler {
    bin: PathBuf,
    timeout: Duration,
    permits: Arc<Semaphore>,
}

/// Stands in for LaTeX's `fontenc` package under the XeTeX engine (see `Compiler::compile`).
const FONTENC_SHIM: &str = "\\NeedsTeXFormat{LaTeX2e}\\ProvidesPackage{fontenc}[2024/01/01 Unicode engine: font encodings are not needed]\n\\DeclareOption*{}\\ProcessOptions\\relax\n\\endinput\n";

impl Compiler {
    pub fn new(bin: PathBuf, workers: usize, timeout: Duration) -> Self {
        Self { bin, timeout, permits: Arc::new(Semaphore::new(workers.max(1))) }
    }

    /// Compile a trivial document so Tectonic downloads and caches its TeX bundle *now*, instead
    /// of during a user's first compile (which can take over a minute on a cold cache).
    pub async fn warm_up(&self) -> Result<Duration> {
        let slow = Compiler::new(self.bin.clone(), 1, Duration::from_secs(600));
        let doc = ("main.tex".to_string(), "\\documentclass{article}\\usepackage{amsmath,amssymb,graphicx}\\begin{document}warm\\end{document}".to_string());
        let res = slow.compile(&[doc], &[], "main.tex").await?;
        if res.success { Ok(res.duration) } else { bail!("warm-up compile failed:\n{}", res.log) }
    }

    pub async fn compile(&self, files: &[(String, String)], assets: &[(String, PathBuf)], main: &str) -> Result<CompileResult> {
        let _permit = self.permits.acquire().await.context("compiler pool closed")?;
        let started = Instant::now();

        let dir = tempfile::tempdir().context("creating work dir")?;
        for (name, content) in files {
            let path = safe_join(dir.path(), name)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::write(&path, content).await?;
        }
        // Tectonic is a XeTeX engine: it reads UTF-8 natively and uses Unicode fonts. A pdfLaTeX-style
        // `\usepackage[T1]{fontenc}` would switch it to 8-bit fonts and garble ¿ ¡ « » € “ ” and more,
        // so unless the project brings its own, a stand-in that does nothing is found first.
        if !files.iter().any(|(name, _)| name == "fontenc.sty") {
            fs::write(dir.path().join("fontenc.sty"), FONTENC_SHIM).await?;
        }
        for (name, src) in assets {
            let path = safe_join(dir.path(), name)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::copy(src, &path).await.with_context(|| format!("copying asset `{name}`"))?;
        }
        let main_path = safe_join(dir.path(), main)?;
        if !main_path.exists() {
            bail!("main file `{main}` does not exist in this project");
        }
        let out = dir.path().join("_out");
        fs::create_dir_all(&out).await?;

        let child = Command::new(&self.bin)
            .args(["-X", "compile", "--outdir"])
            .arg(&out)
            .arg(main)
            .current_dir(dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("starting `{}` (is Tectonic installed?)", self.bin.display()))?;

        let (mut log, exited_ok) = match tokio::time::timeout(self.timeout, child.wait_output_lossy()).await {
            Ok(Ok((log, ok))) => (log, ok),
            Ok(Err(e)) => return Err(e),
            Err(_) => (format!("error: compilation timed out after {}s\n", self.timeout.as_secs()), false),
        };

        let stem = Path::new(main).file_stem().and_then(|s| s.to_str()).unwrap_or("main");
        let pdf = match fs::read(out.join(format!("{stem}.pdf"))).await {
            Ok(b) if exited_ok => Some(b),
            _ => None,
        };
        let diagnostics = parse_diagnostics(&log);
        if pdf.is_none() && diagnostics.iter().all(|d| d.severity != "error") {
            log.push_str("\nerror: the engine produced no PDF\n");
        }
        Ok(CompileResult { success: pdf.is_some(), pdf, log, diagnostics, duration: started.elapsed() })
    }
}

/// `child.wait_with_output()` merged into one log string, tolerant of non-UTF-8 engine output.
trait WaitOutputLossy {
    async fn wait_output_lossy(self) -> Result<(String, bool)>;
}
impl WaitOutputLossy for tokio::process::Child {
    async fn wait_output_lossy(self) -> Result<(String, bool)> {
        let out = self.wait_with_output().await.context("waiting for engine")?;
        let mut log = String::from_utf8_lossy(&out.stdout).into_owned();
        log.push_str(&String::from_utf8_lossy(&out.stderr));
        Ok((log, out.status.success()))
    }
}

/// Join a project-relative path onto `base`, rejecting absolute paths and `..`.
pub fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel = Path::new(rel);
    if rel.as_os_str().is_empty() {
        bail!("empty file name");
    }
    for c in rel.components() {
        if !matches!(c, Component::Normal(_)) {
            bail!("illegal path `{}`", rel.display());
        }
    }
    Ok(base.join(rel))
}

/// TeX prefixes messages with `! `; the UI shows its own severity label.
fn clean(m: &str) -> String {
    m.trim().trim_start_matches("! ").trim().to_string()
}

/// Pull `error:`/`warning:` lines (optionally `file:line: message`) out of the engine log.
pub fn parse_diagnostics(log: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for raw in log.lines() {
        let line = raw.trim();
        let (severity, rest) = if let Some(r) = line.strip_prefix("error:") {
            ("error", r)
        } else if let Some(r) = line.strip_prefix("warning:") {
            ("warning", r)
        } else {
            continue;
        };
        let rest = rest.trim();
        // Tectonic follows every located error with this generic summary; it adds only noise.
        if rest.starts_with("something bad happened inside XeTeX") {
            continue;
        }
        let mut parts = rest.splitn(3, ':');
        let located = match (parts.next(), parts.next(), parts.next()) {
            (Some(f), Some(l), Some(m)) if !f.contains(' ') => l.trim().parse::<u32>().ok().map(|n| (f.to_string(), n, m.trim().to_string())),
            _ => None,
        };
        out.push(match located {
            Some((file, line, message)) => Diagnostic { severity: severity.into(), file: Some(file), line: Some(line), message: clean(&message) },
            None => Diagnostic { severity: severity.into(), file: None, line: None, message: clean(rest) },
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_located_and_plain_diagnostics() {
        let log = "note: x\nerror: main.tex:3: LaTeX Error: File `graphicz.sty' not found.\nwarning: Underfull \\hbox\nerror: halted";
        let d = parse_diagnostics(log);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].file.as_deref(), Some("main.tex"));
        assert_eq!(d[0].line, Some(3));
        assert!(d[0].message.starts_with("LaTeX Error"));
        assert_eq!(d[1].severity, "warning");
        assert_eq!(d[1].line, None);
    }

    #[test]
    fn parses_real_tectonic_output() {
        // captured from `tectonic -X compile` (v0.17) on a document with a missing package
        let log = "note: Running TeX ...\nerror: main.tex:3: ! LaTeX Error: File `graphicz.sty' not found.\nerror: something bad happened inside XeTeX; its output follows:\n\n=====\n(main.tex\n! ! LaTeX Error: File `graphicz.sty' not found..\n";
        let d = parse_diagnostics(log);
        assert_eq!(d.len(), 1, "generic summary line must be dropped: {d:?}");
        assert_eq!((d[0].file.as_deref(), d[0].line), (Some("main.tex"), Some(3)));
        assert_eq!(d[0].message, "LaTeX Error: File `graphicz.sty' not found.");
    }

    #[test]
    fn safe_join_rejects_escapes() {
        let base = Path::new("/tmp/x");
        assert!(safe_join(base, "chapters/a.tex").is_ok());
        assert!(safe_join(base, "../etc/passwd").is_err());
        assert!(safe_join(base, "/etc/passwd").is_err());
        assert!(safe_join(base, "").is_err());
    }
}
