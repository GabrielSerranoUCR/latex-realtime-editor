use std::{env, path::PathBuf, time::Duration};

/// Runtime configuration, read from environment variables (see `.env.example`).
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub tectonic_bin: PathBuf,
    pub allowed_origin: String,
    pub database_url: String,
    /// Send the session cookie only over HTTPS. Must be true in production.
    pub cookie_secure: bool,
    pub session_ttl: Duration,
    /// Where links in emails point (the Angular app's origin).
    pub public_url: String,
    /// Trust `X-Forwarded-For` for client IPs (only behind a proxy you control).
    pub trust_proxy: bool,
    /// Failed sign-ins allowed per email within `login_window` before a lockout.
    pub login_failures_max: u32,
    pub login_window: Duration,
    /// Auth requests allowed per client IP within `login_window`.
    pub ip_auth_max: u32,
    /// Send mail over SMTP instead of writing it to the outbox directory.
    pub smtp_url: Option<String>,
    pub mail_from: String,
    /// Largest accepted upload (images, PDFs).
    pub max_asset_bytes: usize,
    /// Total asset bytes allowed per scroll.
    pub asset_quota_bytes: i64,
    /// Minimum time between automatic version snapshots of a scroll.
    pub version_interval: Duration,
    pub compile_workers: usize,
    pub compile_timeout: Duration,
    pub persist_debounce: Duration,
}

impl Config {
    pub fn from_env() -> Self {
        let get = |k: &str, d: &str| env::var(k).unwrap_or_else(|_| d.to_string());
        Self {
            port: get("QUILL_PORT", "8080").parse().expect("QUILL_PORT must be a number"),
            data_dir: PathBuf::from(get("QUILL_DATA_DIR", "./data")),
            tectonic_bin: PathBuf::from(get("QUILL_TECTONIC_BIN", "tectonic")),
            allowed_origin: get("QUILL_ALLOWED_ORIGIN", "http://localhost:4200"),
            database_url: get("QUILL_DATABASE_URL", "postgres://quill:quill@localhost:5434/quill"),
            cookie_secure: get("QUILL_COOKIE_SECURE", "false") == "true",
            public_url: env::var("QUILL_PUBLIC_URL").unwrap_or_else(|_| get("QUILL_ALLOWED_ORIGIN", "http://localhost:4200")),
            trust_proxy: get("QUILL_TRUST_PROXY", "false") == "true",
            login_failures_max: get("QUILL_LOGIN_FAILURES_MAX", "5").parse().expect("QUILL_LOGIN_FAILURES_MAX must be a number"),
            login_window: Duration::from_secs(60 * get("QUILL_LOGIN_WINDOW_MINUTES", "15").parse::<u64>().expect("QUILL_LOGIN_WINDOW_MINUTES must be a number")),
            ip_auth_max: get("QUILL_IP_AUTH_MAX", "60").parse().expect("QUILL_IP_AUTH_MAX must be a number"),
            smtp_url: env::var("QUILL_SMTP_URL").ok().filter(|s| !s.is_empty()),
            mail_from: get("QUILL_MAIL_FROM", "The Gilded Quill <noreply@localhost>"),
            max_asset_bytes: get("QUILL_MAX_ASSET_MB", "25").parse::<usize>().expect("QUILL_MAX_ASSET_MB must be a number") * 1024 * 1024,
            asset_quota_bytes: get("QUILL_ASSET_QUOTA_MB", "200").parse::<i64>().expect("QUILL_ASSET_QUOTA_MB must be a number") * 1024 * 1024,
            version_interval: Duration::from_secs(60 * get("QUILL_VERSION_INTERVAL_MINUTES", "10").parse::<u64>().expect("QUILL_VERSION_INTERVAL_MINUTES must be a number")),
            session_ttl: Duration::from_secs(60 * 60 * 24 * get("QUILL_SESSION_DAYS", "30").parse::<u64>().expect("QUILL_SESSION_DAYS must be a number")),
            compile_workers: get("QUILL_COMPILE_WORKERS", "2").parse().expect("QUILL_COMPILE_WORKERS must be a number"),
            compile_timeout: Duration::from_secs(get("QUILL_COMPILE_TIMEOUT_SECS", "60").parse().expect("QUILL_COMPILE_TIMEOUT_SECS must be a number")),
            persist_debounce: Duration::from_millis(1500),
        }
    }

    /// Config for tests: temp data dir, stub compiler, fast persistence.
    pub fn for_tests(data_dir: PathBuf, tectonic_bin: PathBuf, database_url: String) -> Self {
        Self {
            port: 0,
            data_dir,
            tectonic_bin,
            allowed_origin: "http://localhost:4200".into(),
            database_url,
            cookie_secure: false,
            session_ttl: Duration::from_secs(3600),
            public_url: "http://localhost:4200".into(),
            trust_proxy: false,
            login_failures_max: 5,
            login_window: Duration::from_secs(900),
            ip_auth_max: 100_000, // tests share one IP; a dedicated test lowers this
            smtp_url: None,
            mail_from: "The Gilded Quill <noreply@localhost>".into(),
            max_asset_bytes: 1024 * 1024,
            asset_quota_bytes: 4 * 1024 * 1024,
            version_interval: Duration::from_secs(3600), // tests that need auto-snapshots lower this
            compile_workers: 2,
            compile_timeout: Duration::from_secs(10),
            persist_debounce: Duration::from_millis(50),
        }
    }
}
