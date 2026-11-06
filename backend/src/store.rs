use std::path::{Path, PathBuf};
use tokio::fs;

/// Filesystem persistence for document snapshots and compiled PDFs.
///
/// This is the seam for the architecture's PostgreSQL/Redis (document state) and object
/// storage (PDFs): swap this struct for implementations backed by those services.
#[derive(Debug, Clone)]
pub struct FsStore {
    root: PathBuf,
}

impl FsStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn docs_dir(&self) -> PathBuf {
        self.root.join("docs")
    }

    fn doc_path(&self, room: &str) -> PathBuf {
        self.root.join("docs").join(format!("{room}.ydoc"))
    }

    pub fn pdf_path(&self, room: &str) -> PathBuf {
        self.root.join("pdfs").join(room).join("latest.pdf")
    }

    pub fn asset_path(&self, room: &str, path: &str) -> PathBuf {
        self.root.join("assets").join(room).join(path)
    }

    pub async fn save_asset(&self, room: &str, path: &str, bytes: &[u8]) -> std::io::Result<()> {
        write_atomic(&self.asset_path(room, path), bytes).await
    }

    pub async fn load_asset(&self, room: &str, path: &str) -> std::io::Result<Option<Vec<u8>>> {
        match fs::read(self.asset_path(room, path)).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Move (or, with `keep`, copy) an asset's bytes within a room. A move is a rename on the same disk,
    /// so even a large file costs nothing; the caller has already reserved the new path.
    pub async fn move_asset(&self, room: &str, from: &str, to: &str, keep: bool) -> std::io::Result<()> {
        let (src, dst) = (self.asset_path(room, from), self.asset_path(room, to));
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).await?;
        }
        if keep {
            fs::copy(&src, &dst).await.map(|_| ())
        } else {
            fs::rename(&src, &dst).await
        }
    }

    pub async fn remove_asset(&self, room: &str, path: &str) {
        let _ = fs::remove_file(self.asset_path(room, path)).await;
    }

    pub async fn load_doc(&self, room: &str) -> std::io::Result<Option<Vec<u8>>> {
        match fs::read(self.doc_path(room)).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn save_doc(&self, room: &str, bytes: &[u8]) -> std::io::Result<()> {
        write_atomic(&self.doc_path(room), bytes).await
    }

    pub fn synctex_path(&self, room: &str) -> PathBuf {
        self.root.join("pdfs").join(room).join("latest.synctex.gz")
    }

    /// The SyncTeX data of the latest build; a build without it removes the old one (it would point at the wrong lines).
    pub async fn save_synctex(&self, room: &str, bytes: Option<&[u8]>) -> std::io::Result<()> {
        match bytes {
            Some(b) => write_atomic(&self.synctex_path(room), b).await,
            None => match fs::remove_file(self.synctex_path(room)).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            },
        }
    }

    pub async fn load_synctex(&self, room: &str) -> std::io::Result<Option<Vec<u8>>> {
        match fs::read(self.synctex_path(room)).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn save_pdf(&self, room: &str, bytes: &[u8]) -> std::io::Result<()> {
        write_atomic(&self.pdf_path(room), bytes).await
    }

    /// Delete everything stored for a room (used when an account deletion removes its scrolls).
    pub async fn remove_room(&self, room: &str) {
        let _ = fs::remove_file(self.doc_path(room)).await;
        let _ = fs::remove_dir_all(self.root.join("pdfs").join(room)).await;
        let _ = fs::remove_dir_all(self.root.join("assets").join(room)).await;
    }

    pub async fn load_pdf(&self, room: &str) -> std::io::Result<Option<Vec<u8>>> {
        match fs::read(self.pdf_path(room)).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).await?;
    fs::rename(&tmp, path).await
}
