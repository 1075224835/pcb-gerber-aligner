use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const GERBER_EXTENSIONS: &[&str] = &[
    "gbr", "gtl", "gbl", "gto", "gbo", "gts", "gbs", "gtp", "gbp", "g1", "g2", "g3", "g4", "gg1",
    "gg2", "gg3", "gd1", "gd2", "gd3", "gpt", "gpb", "gm", "gm1", "gm13", "gm15", "txt", "drl",
    "xln", "nc", "tx1", "tx2",
];

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedGerberFile {
    name: String,
    path: String,
    text: String,
    size: u64,
    modified_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedScanFile {
    name: String,
    path: String,
    bytes_base64: String,
    mime_type: String,
    size: u64,
    modified_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedDirectory<T> {
    directory: String,
    files: Vec<T>,
}

#[tauri::command]
fn pick_gerber_directory_path(default_directory: Option<String>) -> Result<Option<String>, String> {
    Ok(pick_directory(default_directory, "Select Gerber folder").map(|path| path_string(&path)))
}

#[tauri::command]
fn pick_scan_directory_path(default_directory: Option<String>) -> Result<Option<String>, String> {
    Ok(
        pick_directory(default_directory, "Select scan image folder")
            .map(|path| path_string(&path)),
    )
}

#[tauri::command]
fn import_gerber_directory(
    directory: String,
) -> Result<ImportedDirectory<ImportedGerberFile>, String> {
    read_gerber_directory(PathBuf::from(directory))
}

#[tauri::command]
fn import_scan_directory(directory: String) -> Result<ImportedDirectory<ImportedScanFile>, String> {
    read_scan_directory(PathBuf::from(directory))
}

#[tauri::command]
fn pick_gerber_directory(
    default_directory: Option<String>,
) -> Result<Option<ImportedDirectory<ImportedGerberFile>>, String> {
    let Some(directory) = pick_directory(default_directory, "Select Gerber folder") else {
        return Ok(None);
    };

    read_gerber_directory(directory).map(Some)
}

#[tauri::command]
fn pick_scan_directory(
    default_directory: Option<String>,
) -> Result<Option<ImportedDirectory<ImportedScanFile>>, String> {
    let Some(directory) = pick_directory(default_directory, "Select scan image folder") else {
        return Ok(None);
    };

    read_scan_directory(directory).map(Some)
}

fn read_gerber_directory(
    directory: PathBuf,
) -> Result<ImportedDirectory<ImportedGerberFile>, String> {
    if !directory.is_dir() {
        return Err(format!(
            "Gerber folder does not exist: {}",
            path_string(&directory)
        ));
    }

    let files = collect_files(&directory, GERBER_EXTENSIONS)?
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path).map_err(|error| format!("Read Gerber failed: {error}"))?;
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Read Gerber metadata failed: {error}"))?;
            Ok(ImportedGerberFile {
                name: file_name(&path),
                path: path_string(&path),
                text: String::from_utf8_lossy(&bytes).into_owned(),
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(ImportedDirectory {
        directory: path_string(&directory),
        files,
    })
}

fn read_scan_directory(directory: PathBuf) -> Result<ImportedDirectory<ImportedScanFile>, String> {
    if !directory.is_dir() {
        return Err(format!(
            "Scan image folder does not exist: {}",
            path_string(&directory)
        ));
    }

    let files = collect_files(&directory, IMAGE_EXTENSIONS)?
        .into_iter()
        .map(|path| {
            let bytes =
                fs::read(&path).map_err(|error| format!("Read scan image failed: {error}"))?;
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Read scan image metadata failed: {error}"))?;
            Ok(ImportedScanFile {
                name: file_name(&path),
                path: path_string(&path),
                bytes_base64: STANDARD.encode(bytes),
                mime_type: mime_type(&path).to_string(),
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(ImportedDirectory {
        directory: path_string(&directory),
        files,
    })
}

fn pick_directory(default_directory: Option<String>, title: &str) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title(title);
    if let Some(default_directory) = default_directory {
        let path = PathBuf::from(default_directory);
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        }
    }
    dialog.pick_folder()
}

fn collect_files(directory: &Path, extensions: &[&str]) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_files_recursively(directory, extensions, &mut files)?;
    files.sort_by(|a, b| {
        file_name(a)
            .cmp(&file_name(b))
            .then_with(|| path_string(a).cmp(&path_string(b)))
    });
    Ok(files)
}

fn collect_files_recursively(
    directory: &Path,
    extensions: &[&str],
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| format!("Read folder failed: {error}"))? {
        let entry = entry.map_err(|error| format!("Read folder entry failed: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursively(&path, extensions, files)?;
            continue;
        }
        if has_extension(&path, extensions) {
            files.push(path);
        }
    }
    Ok(())
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn modified_ms(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_gerber_directory_path,
            pick_scan_directory_path,
            import_gerber_directory,
            import_scan_directory,
            pick_gerber_directory,
            pick_scan_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
