//! SyncTeX: from a point on a page of the compiled PDF back to the source file and line that made it.
//!
//! Tectonic writes `<name>.synctex.gz` when asked (`--synctex`). We keep it next to the PDF, with the
//! `Input:` paths rewritten to project paths, and read it when a scribe double-clicks the preview.
//! Only the "reverse" direction (PDF → source) is needed.

use std::{
    collections::HashMap,
    io::{Read, Write},
};

use flate2::{Compression, read::GzDecoder, write::GzEncoder};

pub fn pack(text: &str) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    let _ = enc.write_all(text.as_bytes());
    enc.finish().unwrap_or_default()
}

pub fn unpack(gz: &[u8]) -> Option<String> {
    let mut out = String::new();
    GzDecoder::new(gz).read_to_string(&mut out).ok()?;
    Some(out)
}

/// Rewrite `Input:N:/some/temp/dir/chapters/a.tex` to `Input:N:chapters/a.tex`, using the project's own file names
/// (the longest one the path ends with), so the lookup does not depend on where the compile happened.
pub fn relativize(text: &str, names: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Input:") {
            if let Some((tag, path)) = rest.split_once(':') {
                let path = path.trim_start_matches("./");
                let best = names.iter().filter(|n| path == n.as_str() || path.ends_with(&format!("/{n}"))).max_by_key(|n| n.len());
                out.push_str(&format!("Input:{tag}:{}\n", best.map(String::as_str).unwrap_or("")));
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Located {
    pub file: String,
    pub line: u32,
}

struct HBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    d: f64,
    first: usize,
    last: usize,
}

struct Leaf {
    tag: u32,
    line: u32,
    x: f64,
}

/// `tag,line:x,y[:w,h,d]` → (tag, line, x, y, [w, h, d])
fn record(s: &str) -> Option<(u32, u32, i64, i64, Option<[i64; 3]>)> {
    let (head, rest) = s.split_once(':')?;
    let (tag, line) = head.split_once(',')?;
    let (pos, size) = match rest.split_once(':') {
        Some((p, sz)) => (p, Some(sz)),
        None => (rest, None),
    };
    let (x, y) = pos.split_once(',')?;
    let size = size.and_then(|sz| {
        let mut it = sz.split(',').map(|v| v.parse::<i64>().ok());
        Some([it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0)])
    });
    Some((tag.parse().ok()?, line.parse().ok()?, x.parse().ok()?, y.parse().ok()?, size))
}

/// Which source line made the thing at (`x`, `y`), in PDF points from the page's top-left corner, on 1-based `page`.
pub fn locate(text: &str, page: u32, x: f64, y: f64) -> Option<Located> {
    let mut inputs: HashMap<u32, String> = HashMap::new();
    let (mut mag, mut unit) = (1000.0_f64, 1.0_f64);
    let mut in_page = false;
    let mut boxes: Vec<HBox> = Vec::new();
    let mut leaves: Vec<Leaf> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    // scaled points → PDF points (72 per inch; TeX has 72.27 per inch)
    let to_pt = |v: i64, mag: f64, unit: f64| v as f64 * unit * (mag / 1000.0) / 65536.0 * 72.0 / 72.27;

    for line in text.lines() {
        let mut chars = line.chars();
        let Some(kind) = chars.next() else { continue };
        let rest = chars.as_str();
        if !in_page {
            if let Some(v) = line.strip_prefix("Input:") {
                if let Some((tag, path)) = v.split_once(':') {
                    if let Ok(t) = tag.parse() {
                        inputs.insert(t, path.to_string());
                    }
                }
            } else if let Some(v) = line.strip_prefix("Magnification:") {
                mag = v.trim().parse().unwrap_or(1000.0);
            } else if let Some(v) = line.strip_prefix("Unit:") {
                unit = v.trim().parse().unwrap_or(1.0);
            } else if kind == '{' && rest.trim().parse::<u32>().ok() == Some(page) {
                in_page = true;
            }
            continue;
        }
        match kind {
            '}' => break,
            '(' => {
                if let Some((_, _, bx, by, size)) = record(rest) {
                    let [w, h, d] = size.unwrap_or([0, 0, 0]);
                    boxes.push(HBox { x: to_pt(bx, mag, unit), y: to_pt(by, mag, unit), w: to_pt(w, mag, unit), h: to_pt(h, mag, unit), d: to_pt(d, mag, unit), first: leaves.len(), last: leaves.len() });
                    open.push(boxes.len() - 1);
                }
            }
            ')' => {
                if let Some(i) = open.pop() {
                    boxes[i].last = leaves.len();
                }
            }
            'g' | 'k' | 'x' | '$' | 'h' | 'v' => {
                if let Some((tag, line, lx, _, _)) = record(rest) {
                    leaves.push(Leaf { tag, line, x: to_pt(lx, mag, unit) });
                }
            }
            _ => {}
        }
    }

    // the line box under the point (the smallest one that holds it), else the nearest one vertically
    let tolerance = 1.0;
    let band = |b: &HBox| (b.y - b.h, b.y + b.d);
    let has_leaves = |b: &&HBox| b.last > b.first;
    let inside = boxes.iter().filter(has_leaves).filter(|b| {
        let (top, bottom) = band(b);
        y >= top - tolerance && y <= bottom + tolerance && x >= b.x - tolerance && x <= b.x + b.w + tolerance
    });
    let chosen = inside.min_by(|a, b| (a.w * (a.h + a.d)).total_cmp(&(b.w * (b.h + b.d)))).or_else(|| {
        boxes.iter().filter(has_leaves).filter(|b| b.h + b.d > 0.0).min_by(|a, b| {
            let dist = |b: &HBox| {
                let (top, bottom) = band(b);
                let dy = if y < top { top - y } else if y > bottom { y - bottom } else { 0.0 };
                let dx = if x < b.x { b.x - x } else if x > b.x + b.w { x - b.x - b.w } else { 0.0 };
                dy * 4.0 + dx
            };
            dist(a).total_cmp(&dist(b))
        })
    })?;

    // inside that line, the last thing that starts at or before the point
    let candidates: Vec<&Leaf> = leaves[chosen.first..chosen.last].iter().filter(|l| l.line > 0).collect();
    let leaf = candidates.iter().filter(|l| l.x <= x).max_by(|a, b| a.x.total_cmp(&b.x)).or_else(|| candidates.first())?;
    let file = inputs.get(&leaf.tag).filter(|f| !f.is_empty())?.clone();
    Some(Located { file, line: leaf.line })
}

#[cfg(test)]
mod tests {
    use super::*;

    // from a real `tectonic -X compile --synctex` of a three-paragraph document (paths shortened)
    const SAMPLE: &str = "SyncTeX Version:1\nInput:1:/tmp/work/main.tex\nInput:2:/tmp/work/chapters/two.tex\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n!268\n{1\n[1,9:4736287,46220575:26673152,41484288,0\n(1,9:4736287,4736287:0,0,0\n)\n[1,9:8799519,44254495:22609920,36044800,0\n(1,4:8799519,8865055:22609920,454820,7208\nh1,3:8799519,8865055:983040,0,0\ng1,3:11475354,8865055\ng1,3:13279560,8865055\nk1,4:31409439,8865055:14341243\n)\n(1,6:8799519,9651487:22609920,462029,135003\nh1,5:8799519,9651487:983040,0,0\nk1,5:12045142,9651487:259803\nk1,5:31409439,9651487:0\n)\n(2,8:8799519,12606177:22609920,647391,5661\ng2,8:8799519,12606177\ng2,8:10274550,12606177\n)\n]\n]\n}1\n";

    #[test]
    fn a_click_on_a_line_finds_its_source_line() {
        // "Hello" sits at about x=149, baseline y=134.8 (points from the top-left): source line 3
        assert_eq!(locate(SAMPLE, 1, 150.0, 130.0), Some(Located { file: "/tmp/work/main.tex".into(), line: 3 }));
        // the next paragraph: source line 5
        assert_eq!(locate(SAMPLE, 1, 160.0, 144.0), Some(Located { file: "/tmp/work/main.tex".into(), line: 5 }));
    }

    #[test]
    fn a_click_picks_the_thing_before_it_on_the_line_and_the_right_file() {
        // far right of the first line, past the second glue: still line 3
        assert_eq!(locate(SAMPLE, 1, 400.0, 130.0).map(|l| l.line), Some(3));
        // the line from the other input file (y = 12606177 sp ≈ 192 pt)
        assert_eq!(locate(SAMPLE, 1, 200.0, 190.0), Some(Located { file: "/tmp/work/chapters/two.tex".into(), line: 8 }));
    }

    #[test]
    fn a_click_in_the_margin_snaps_to_the_nearest_line_and_other_pages_find_nothing() {
        assert_eq!(locate(SAMPLE, 1, 20.0, 131.0).map(|l| l.line), Some(3));
        assert_eq!(locate(SAMPLE, 2, 150.0, 130.0), None);
    }

    #[test]
    fn inputs_become_project_paths() {
        let names = vec!["main.tex".to_string(), "chapters/two.tex".to_string(), "two.tex".to_string()];
        let text = relativize(SAMPLE, &names);
        assert!(text.contains("Input:1:main.tex\n"));
        assert!(text.contains("Input:2:chapters/two.tex\n"));
        assert_eq!(locate(&text, 1, 150.0, 130.0), Some(Located { file: "main.tex".into(), line: 3 }));
    }

    #[test]
    fn it_survives_packing() {
        assert_eq!(unpack(&pack("hello")).as_deref(), Some("hello"));
    }
}
