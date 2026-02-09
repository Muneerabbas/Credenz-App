import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, "storage.json");
const DEFAULT_ROOT = path.join(__dirname, "sample_storage");
const STORAGE_ROOT = process.env.STORAGE_ROOT || DEFAULT_ROOT;
const ALLOW_DELETE = process.env.CLEANER_ALLOW_DELETE === "true";

const app = express();
app.use(cors());
app.use(express.json());

const MB = 1024 * 1024;
const MEDIA_EXTS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".iso"
]);
const LOG_EXTS = new Set([".log"]);
const IGNORED_DIRS = new Set(["node_modules", ".git", ".expo"]);

const emptyStore = () => ({
  history: []
});

const loadStore = () => {
  if (!fs.existsSync(DATA_PATH)) return emptyStore();
  const raw = fs.readFileSync(DATA_PATH, "utf-8");
  try {
    const data = JSON.parse(raw);
    return { history: Array.isArray(data.history) ? data.history : [] };
  } catch {
    return emptyStore();
  }
};

const saveStore = (store) => {
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
};

const toMB = (bytes) => Math.max(0, Math.round(bytes / MB));

const categorizeFile = (filePath) => {
  const lower = filePath.toLowerCase();
  if (lower.includes(`${path.sep}cache${path.sep}`) || lower.includes(`${path.sep}tmp${path.sep}`)) {
    return "cache";
  }
  if (lower.includes(`${path.sep}downloads${path.sep}`)) {
    return "downloads";
  }
  const ext = path.extname(lower);
  if (MEDIA_EXTS.has(ext)) return "media";
  if (LOG_EXTS.has(ext)) return "logs";
  return null;
};

const scanRoot = async () => {
  const files = [];
  const stack = [STORAGE_ROOT];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = path.join(current, entry.name);
      let stat;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }
      files.push({
        path: fullPath,
        name: entry.name,
        size: stat.size,
        category: categorizeFile(fullPath)
      });
    }
  }

  const duplicateMap = new Map();
  for (const file of files) {
    const key = `${file.name}:${file.size}`;
    if (!duplicateMap.has(key)) duplicateMap.set(key, []);
    duplicateMap.get(key).push(file);
  }

  const categoryFiles = {
    cache: [],
    downloads: [],
    duplicates: [],
    media: [],
    logs: []
  };

  for (const [, group] of duplicateMap.entries()) {
    if (group.length > 1) {
      for (const file of group.slice(1)) {
        file.category = "duplicates";
      }
    }
  }

  for (const file of files) {
    if (file.category && categoryFiles[file.category]) {
      categoryFiles[file.category].push(file);
    }
  }

  const categories = [
    {
      id: "cache",
      name: "App Cache",
      description: "Temporary app data",
      sizeMB: toMB(categoryFiles.cache.reduce((s, f) => s + f.size, 0))
    },
    {
      id: "downloads",
      name: "Downloads",
      description: "Unsorted files",
      sizeMB: toMB(categoryFiles.downloads.reduce((s, f) => s + f.size, 0))
    },
    {
      id: "duplicates",
      name: "Duplicates",
      description: "Exact file copies",
      sizeMB: toMB(categoryFiles.duplicates.reduce((s, f) => s + f.size, 0))
    },
    {
      id: "media",
      name: "Large Media",
      description: "Videos and archives",
      sizeMB: toMB(categoryFiles.media.reduce((s, f) => s + f.size, 0))
    },
    {
      id: "logs",
      name: "Old Logs",
      description: "System logs",
      sizeMB: toMB(categoryFiles.logs.reduce((s, f) => s + f.size, 0))
    }
  ];

  const totalUsedMB = toMB(files.reduce((s, f) => s + f.size, 0));
  const totalReclaimableMB = categories.reduce((s, c) => s + c.sizeMB, 0);

  return {
    lastScan: new Date().toISOString(),
    totalUsedMB,
    totalReclaimableMB,
    categories,
    categoryFiles
  };
};

const withinRoot = (filePath) => {
  const resolvedRoot = path.resolve(STORAGE_ROOT) + path.sep;
  const resolvedPath = path.resolve(filePath);
  return resolvedPath.startsWith(resolvedRoot);
};

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), root: STORAGE_ROOT });
});

app.get("/api/overview", async (req, res) => {
  const store = loadStore();
  const scan = await scanRoot();
  res.json({
    ...scan,
    history: store.history
  });
});

app.get("/api/history", (req, res) => {
  const store = loadStore();
  res.json({ history: store.history });
});

app.post("/api/clean", async (req, res) => {
  const { categories } = req.body || {};
  const targetIds = Array.isArray(categories) ? new Set(categories) : new Set();

  const scan = await scanRoot();
  const filesToClean = [];

  for (const id of targetIds) {
    const list = scan.categoryFiles[id] || [];
    filesToClean.push(...list);
  }

  let cleanedBytes = 0;
  let cleanedFiles = 0;
  let simulated = false;

  if (ALLOW_DELETE) {
    for (const file of filesToClean) {
      if (!withinRoot(file.path)) continue;
      try {
        await fs.promises.unlink(file.path);
        cleanedBytes += file.size;
        cleanedFiles += 1;
      } catch {
        continue;
      }
    }
  } else {
    simulated = true;
    cleanedBytes = filesToClean.reduce((s, f) => s + f.size, 0);
    cleanedFiles = filesToClean.length;
  }

  const updatedScan = await scanRoot();
  const store = loadStore();
  store.history.unshift({
    id: `clean_${Date.now()}`,
    time: new Date().toISOString(),
    cleanedMB: toMB(cleanedBytes),
    cleanedFiles,
    categories: Array.from(targetIds),
    simulated
  });
  store.history = store.history.slice(0, 10);
  saveStore(store);

  res.json({
    ...updatedScan,
    cleanedMB: toMB(cleanedBytes),
    cleanedFiles,
    simulated,
    history: store.history
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Storage cleaner API running on http://localhost:${PORT}`);
  console.log(`Scanning root: ${STORAGE_ROOT}`);
  console.log(`Deletion enabled: ${ALLOW_DELETE}`);
});
