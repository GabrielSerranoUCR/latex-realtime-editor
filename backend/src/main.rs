use quill_server::{AppState, config::Config, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "quill_server=info,tower_http=info".into()))
        .init();

    let config = Config::from_env();
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], config.port));
    let db = quill_server::db::connect(&config.database_url).await?;
    quill_server::db::migrate(&db).await?;
    let state = AppState::new(config.clone(), db);
    match state.rooms.import_fs_docs().await {
        Ok(0) => {}
        Ok(n) => tracing::info!(count = n, "imported documents from the old filesystem store"),
        Err(e) => tracing::warn!(error = ?e, "could not import old documents"),
    }
    let compiler = state.compiler.clone();
    tokio::spawn(async move {
        match compiler.warm_up().await {
            Ok(took) => tracing::info!(took_ms = took.as_millis() as u64, "compiler warmed up (TeX bundle cached)"),
            Err(e) => tracing::warn!(error = %e, "compiler warm-up failed; is Tectonic installed? compiles will fail until it is"),
        }
    });
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, data_dir = %config.data_dir.display(), "quill-server listening");
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}
