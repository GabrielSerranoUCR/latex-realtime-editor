//! Outgoing email.
//!
//! * With `QUILL_SMTP_URL` set, mail goes out over SMTP (e.g. `smtps://user:pass@smtp.example:465`
//!   or `smtp://localhost:2525` for a local relay).
//! * Otherwise every message is written to an outbox directory (and logged): what development and
//!   the tests read.

use std::path::PathBuf;

use anyhow::{Context, Result};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::header::ContentType};
use tokio::fs;
use uuid::Uuid;

enum Transport {
    Outbox(PathBuf),
    Smtp { transport: AsyncSmtpTransport<Tokio1Executor>, from: String },
}

pub struct Mailer {
    transport: Transport,
}

impl std::fmt::Debug for Mailer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.transport {
            Transport::Outbox(_) => "Mailer(outbox)",
            Transport::Smtp { .. } => "Mailer(smtp)",
        })
    }
}

impl Mailer {
    pub fn outbox(dir: PathBuf) -> Self {
        Self { transport: Transport::Outbox(dir) }
    }

    pub fn smtp(url: &str, from: &str) -> Result<Self> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url).context("parsing QUILL_SMTP_URL")?.build();
        from.parse::<lettre::message::Mailbox>().context("parsing QUILL_MAIL_FROM")?;
        Ok(Self { transport: Transport::Smtp { transport, from: from.to_string() } })
    }

    pub async fn send(&self, to: &str, subject: &str, body: &str) -> Result<()> {
        match &self.transport {
            Transport::Outbox(dir) => {
                fs::create_dir_all(dir).await.context("creating outbox")?;
                let name = format!("{}-{}.txt", chrono::Utc::now().format("%Y%m%dT%H%M%S%.6f"), Uuid::new_v4().simple());
                // header injection guard: header values must be single-line
                let one_line = |s: &str| s.replace(['\r', '\n'], " ");
                let message = format!("To: {}\nSubject: {}\n\n{}\n", one_line(to), one_line(subject), body);
                fs::write(dir.join(name), message).await.context("writing mail")?;
                tracing::info!(to, subject, "mail written to outbox");
            }
            Transport::Smtp { transport, from } => {
                // lettre validates addresses and rejects header injection itself
                let message = Message::builder()
                    .from(from.parse().context("from address")?)
                    .to(to.parse().with_context(|| format!("recipient `{to}`"))?)
                    .subject(subject)
                    .header(ContentType::TEXT_PLAIN)
                    .body(body.to_string())
                    .context("building message")?;
                transport.send(message).await.context("sending mail over SMTP")?;
                tracing::info!(to, subject, "mail sent");
            }
        }
        Ok(())
    }
}
