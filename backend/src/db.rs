use anyhow::{Context, Result};
use sqlx::{PgPool, postgres::PgPoolOptions};

pub async fn connect(url: &str) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(10)
        .connect(url)
        .await
        .with_context(|| "connecting to PostgreSQL (is `docker compose up -d db` running?)")
}

/// Applies `migrations/*.sql` (embedded into the binary at build time).
pub async fn migrate(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("./migrations").run(pool).await.context("running migrations")
}
