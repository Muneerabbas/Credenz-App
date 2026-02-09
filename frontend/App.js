import { useEffect, useMemo, useRef, useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  StyleSheet,
  Pressable,
  Switch,
  Platform,
  Animated,
  Easing
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as FileSystem from "expo-file-system";
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_BASE = "http://localhost:4000";
const HISTORY_KEY = "@storage_cleaner_history";
const MAX_SCAN_FILES = 1500;

const fallbackData = {
  totalUsedMB: 11600,
  totalReclaimableMB: 4460,
  lastScan: new Date().toISOString(),
  history: [],
  categories: [
    { id: "cache", name: "App Cache", sizeMB: 1240, description: "Temporary app data" },
    { id: "downloads", name: "Downloads", sizeMB: 860, description: "Unsorted files" },
    { id: "duplicates", name: "Duplicates", sizeMB: 430, description: "Exact file copies" },
    { id: "media", name: "Large Media", sizeMB: 1720, description: "Videos and archives" },
    { id: "logs", name: "Old Logs", sizeMB: 210, description: "System logs" }
  ]
};

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

const formatMB = (mb) => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
};

const formatDate = (iso) => {
  const date = new Date(iso);
  return date.toLocaleString();
};

const guessNameFromUri = (uri) => {
  const last = uri.split("/").pop() || uri;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

const categorizeName = (name, uri) => {
  const lower = `${name} ${uri}`.toLowerCase();
  if (lower.includes("/cache/") || lower.includes("/tmp/")) return "cache";
  if (lower.includes("downloads") || lower.includes("download")) return "downloads";
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  if (MEDIA_EXTS.has(ext)) return "media";
  if (LOG_EXTS.has(ext)) return "logs";
  return null;
};

const buildCategories = (files) => {
  const categories = {
    cache: [],
    downloads: [],
    duplicates: [],
    media: [],
    logs: []
  };

  const duplicateMap = new Map();
  for (const file of files) {
    const key = `${file.name}:${file.size}`;
    if (!duplicateMap.has(key)) duplicateMap.set(key, []);
    duplicateMap.get(key).push(file);
  }

  for (const [, group] of duplicateMap.entries()) {
    if (group.length > 1) {
      for (const file of group.slice(1)) {
        file.category = "duplicates";
      }
    }
  }

  for (const file of files) {
    if (file.category && categories[file.category]) {
      categories[file.category].push(file);
    }
  }

  const summarize = (id, name, description) => ({
    id,
    name,
    description,
    sizeMB: Math.round(categories[id].reduce((s, f) => s + f.size, 0) / (1024 * 1024))
  });

  const list = [
    summarize("cache", "App Cache", "Temporary app data"),
    summarize("downloads", "Downloads", "Unsorted files"),
    summarize("duplicates", "Duplicates", "Exact file copies"),
    summarize("media", "Large Media", "Videos and archives"),
    summarize("logs", "Old Logs", "System logs")
  ];

  const totalUsedMB = Math.round(files.reduce((s, f) => s + f.size, 0) / (1024 * 1024));
  const totalReclaimableMB = list.reduce((s, c) => s + c.sizeMB, 0);

  return { list, categories, totalUsedMB, totalReclaimableMB };
};

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState({});
  const [actionNote, setActionNote] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [deviceMode, setDeviceMode] = useState(Platform.OS === "android");
  const [directoryUri, setDirectoryUri] = useState(null);
  const [scanNote, setScanNote] = useState("");
  const [scanLimitReached, setScanLimitReached] = useState(false);
  const [debugNote, setDebugNote] = useState("");
  const progress = useRef(new Animated.Value(0)).current;

  const loadOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/overview`);
      if (!res.ok) throw new Error("Failed to load");
      const json = await res.json();
      setData(json);
      const nextSelected = {};
      json.categories.forEach((c) => {
        nextSelected[c.id] = true;
      });
      setSelected(nextSelected);
    } catch (err) {
      setError("Backend unavailable. Showing sample data.");
      setData(fallbackData);
      const nextSelected = {};
      fallbackData.categories.forEach((c) => {
        nextSelected[c.id] = true;
      });
      setSelected(nextSelected);
    } finally {
      setLoading(false);
    }
  };

  const loadLocalHistory = async () => {
    try {
      const raw = await AsyncStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const saveLocalHistory = async (history) => {
    try {
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      return;
    }
  };

  useEffect(() => {
    if (deviceMode) return;
    loadOverview();
  }, [deviceMode]);

  useEffect(() => {
    if (!deviceMode) return;
    (async () => {
      const history = await loadLocalHistory();
      setData((prev) => ({
        ...(prev || fallbackData),
        history
      }));
    })();
  }, [deviceMode]);

  useEffect(() => {
    if (!cleaning) return;
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false
      })
    );
    loop.start();
    return () => loop.stop();
  }, [cleaning, progress]);

  const scanSafTree = async (uri, files) => {
    if (files.length >= MAX_SCAN_FILES) return;
    let info;
    try {
      info = await FileSystem.getInfoAsync(uri);
    } catch {
      return;
    }
    if (!info.exists) return;
    if (info.isDirectory) {
      let children = [];
      try {
        children = await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
      } catch {
        return;
      }
      for (const child of children) {
        if (files.length >= MAX_SCAN_FILES) return;
        await scanSafTree(child, files);
      }
    } else {
      const name = guessNameFromUri(uri);
      const category = categorizeName(name, uri);
      files.push({
        uri,
        name,
        size: info.size || 0,
        category
      });
    }
  };

  const scanDeviceStorage = async (uri) => {
    setLoading(true);
    setError(null);
    setScanNote("Scanning device storage...");
    setScanLimitReached(false);

    const files = [];
    await scanSafTree(uri, files);
    const limitReached = files.length >= MAX_SCAN_FILES;
    setScanLimitReached(limitReached);

    const summary = buildCategories(files);
    const history = await loadLocalHistory();

    setData({
      lastScan: new Date().toISOString(),
      totalUsedMB: summary.totalUsedMB,
      totalReclaimableMB: summary.totalReclaimableMB,
      categories: summary.list,
      history
    });

    const nextSelected = {};
    summary.list.forEach((c) => {
      nextSelected[c.id] = true;
    });
    setSelected(nextSelected);
    setScanNote(limitReached ? "Scan limited to 1500 files." : "Scan complete.");
    setLoading(false);
  };

  const requestDirectory = async () => {
    if (Platform.OS !== "android") return;
    try {
      setDebugNote("Requesting folder permissions...");
      const response = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      setDebugNote(
        `Permission result: granted=${response.granted} uri=${response.directoryUri || "none"}`
      );
      if (!response.granted) {
        setError("Folder access denied.");
        return;
      }
      setDirectoryUri(response.directoryUri);
      await scanDeviceStorage(response.directoryUri);
    } catch {
      setDebugNote("Permission request failed: SAF not available or picker failed.");
      setError("Unable to access folder.");
    }
  };

  const selectedIds = useMemo(
    () => Object.keys(selected).filter((id) => selected[id]),
    [selected]
  );

  const selectedMB = useMemo(() => {
    if (!data) return 0;
    return data.categories
      .filter((c) => selected[c.id])
      .reduce((sum, c) => sum + c.sizeMB, 0);
  }, [data, selected]);

  const runDeviceClean = async () => {
    if (!directoryUri || !data) return;
    setActionNote("Cleaning in progress...");
    setCleaning(true);
    try {
      const files = [];
      await scanSafTree(directoryUri, files);
      const summary = buildCategories(files);

      const targetFiles = [];
      for (const id of selectedIds) {
        targetFiles.push(...summary.categories[id]);
      }

      let cleanedBytes = 0;
      let cleanedFiles = 0;
      for (const file of targetFiles) {
        try {
          await FileSystem.deleteAsync(file.uri, { idempotent: true });
          cleanedBytes += file.size;
          cleanedFiles += 1;
        } catch {
          continue;
        }
      }

      const updatedFiles = [];
      await scanSafTree(directoryUri, updatedFiles);
      const updatedSummary = buildCategories(updatedFiles);
      const history = await loadLocalHistory();
      const entry = {
        id: `clean_${Date.now()}`,
        time: new Date().toISOString(),
        cleanedMB: Math.round(cleanedBytes / (1024 * 1024)),
        cleanedFiles,
        categories: selectedIds,
        simulated: false
      };
      const nextHistory = [entry, ...history].slice(0, 10);
      await saveLocalHistory(nextHistory);

      setData({
        lastScan: new Date().toISOString(),
        totalUsedMB: updatedSummary.totalUsedMB,
        totalReclaimableMB: updatedSummary.totalReclaimableMB,
        categories: updatedSummary.list,
        history: nextHistory
      });

      setActionNote(`Cleaned ${formatMB(entry.cleanedMB)}.`);
    } catch {
      setActionNote("Cleanup failed. Try again.");
    } finally {
      setCleaning(false);
    }
  };

  const runClean = async () => {
    if (deviceMode) {
      await runDeviceClean();
      return;
    }
    if (!data) return;
    setActionNote("Cleaning in progress...");
    setCleaning(true);
    try {
      const res = await fetch(`${API_BASE}/api/clean`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: selectedIds })
      });
      if (!res.ok) throw new Error("Failed to clean");
      const json = await res.json();
      setData(json);
      const modeNote = json.simulated
        ? " (simulated, enable deletion to apply)"
        : "";
      setActionNote(`Cleaned ${formatMB(json.cleanedMB)}.${modeNote}`);
    } catch (err) {
      setActionNote("Cleanup simulated locally.");
      setData((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          categories: prev.categories.map((c) =>
            selected[c.id] ? { ...c, sizeMB: 0 } : c
          )
        };
        const reclaimed = next.categories.reduce((sum, c) => sum + c.sizeMB, 0);
        next.totalReclaimableMB = reclaimed;
        return next;
      });
    } finally {
      setCleaning(false);
    }
  };

  const toggleAll = () => {
    if (!data) return;
    const allSelected = data.categories.every((c) => selected[c.id]);
    const next = {};
    data.categories.forEach((c) => {
      next[c.id] = !allSelected;
    });
    setSelected(next);
  };

  const historyItems = data?.history?.slice(0, 5) || [];
  const modeLabel = deviceMode ? "Device storage" : "Backend scan";

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.backgroundGlowOne} />
      <View style={styles.backgroundGlowTwo} />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.kicker}>Storage Cleaner</Text>
          <Text style={styles.title}>Breathe again. Make space fast.</Text>
          <Text style={styles.subtitle}>
            Mode: {modeLabel}
          </Text>
          <Text style={styles.subtitle}>
            Last scan: {data ? formatDate(data.lastScan) : "Scanning..."}
          </Text>
        </View>

        {Platform.OS === "android" && (
          <View style={styles.devicePanel}>
            <View>
              <Text style={styles.deviceTitle}>Android Folder Access</Text>
              <Text style={styles.deviceSubtitle}>
                {directoryUri ? "Folder connected" : "Pick a folder to scan"}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.deviceButton,
                pressed && { opacity: 0.8 }
              ]}
              onPress={requestDirectory}
            >
              <Text style={styles.deviceButtonText}>
                {directoryUri ? "Change Folder" : "Connect Folder"}
              </Text>
            </Pressable>
          </View>
        )}

        <View style={styles.cardsRow}>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Total used</Text>
            <Text style={styles.cardValue}>
              {data ? formatMB(data.totalUsedMB) : "--"}
            </Text>
            <Text style={styles.cardHint}>Across device storage</Text>
          </View>
          <View style={styles.cardAccent}>
            <Text style={styles.cardLabel}>Reclaimable</Text>
            <Text style={styles.cardValue}>
              {data ? formatMB(data.totalReclaimableMB) : "--"}
            </Text>
            <Text style={styles.cardHint}>Ready to clean</Text>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Cleanup Targets</Text>
          <Pressable onPress={toggleAll} style={styles.toggleAll}>
            <Text style={styles.toggleAllText}>Toggle all</Text>
          </Pressable>
        </View>

        <View style={styles.list}>
          {data?.categories?.map((cat) => (
            <View key={cat.id} style={styles.listItem}>
              <View style={styles.listText}>
                <Text style={styles.listTitle}>{cat.name}</Text>
                <Text style={styles.listSubtitle}>{cat.description}</Text>
              </View>
              <View style={styles.listMeta}>
                <Text style={styles.listValue}>{formatMB(cat.sizeMB)}</Text>
                <Switch
                  value={!!selected[cat.id]}
                  onValueChange={(value) =>
                    setSelected((prev) => ({ ...prev, [cat.id]: value }))
                  }
                  thumbColor={Platform.OS === "android" ? "#0c0c0c" : undefined}
                  trackColor={{ true: "#0ddf9b", false: "#2a2a2a" }}
                />
              </View>
            </View>
          ))}
        </View>

        <View style={styles.actionPanel}>
          <View>
            <Text style={styles.actionLabel}>Selected clean</Text>
            <Text style={styles.actionValue}>{formatMB(selectedMB)}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.cleanButton,
              pressed && { opacity: 0.8 }
            ]}
            onPress={runClean}
            disabled={loading || selectedIds.length === 0 || cleaning}
          >
            <Text style={styles.cleanButtonText}>
              {cleaning ? "Cleaning..." : "Run Clean"}
            </Text>
          </Pressable>
        </View>

        {cleaning && (
          <View style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["10%", "100%"]
                  })
                }
              ]}
            />
          </View>
        )}

        {!!scanNote && <Text style={styles.note}>{scanNote}</Text>}
        {scanLimitReached && (
          <Text style={styles.note}>Large folder detected. Showing partial results.</Text>
        )}
        {!!actionNote && <Text style={styles.note}>{actionNote}</Text>}
        {!!debugNote && <Text style={styles.debug}>{debugNote}</Text>}
        {!!error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent Cleans</Text>
        </View>
        <View style={styles.historyList}>
          {historyItems.length === 0 && (
            <Text style={styles.historyEmpty}>No clean runs yet.</Text>
          )}
          {historyItems.map((item) => (
            <View key={item.id} style={styles.historyItem}>
              <View>
                <Text style={styles.historyTitle}>
                  {formatMB(item.cleanedMB)} cleared
                </Text>
                <Text style={styles.historySubtitle}>
                  {formatDate(item.time)}
                </Text>
              </View>
              <Text style={styles.historyTag}>
                {item.simulated ? "Simulated" : "Applied"}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0b0b0b"
  },
  content: {
    padding: 24,
    paddingBottom: 48
  },
  backgroundGlowOne: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    backgroundColor: "#1e5dff",
    opacity: 0.18,
    top: -80,
    right: -120
  },
  backgroundGlowTwo: {
    position: "absolute",
    width: 260,
    height: 260,
    borderRadius: 999,
    backgroundColor: "#00f5a0",
    opacity: 0.12,
    bottom: -60,
    left: -80
  },
  header: {
    marginBottom: 28
  },
  kicker: {
    color: "#7a7a7a",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 2,
    marginBottom: 10,
    fontFamily: Platform.select({
      ios: "AvenirNext-Regular",
      android: "sans-serif-condensed"
    })
  },
  title: {
    color: "#f8f8f8",
    fontSize: 28,
    fontWeight: "700",
    lineHeight: 34,
    fontFamily: Platform.select({
      ios: "AvenirNext-DemiBold",
      android: "sans-serif-medium"
    })
  },
  subtitle: {
    color: "#9c9c9c",
    fontSize: 13,
    marginTop: 6
  },
  devicePanel: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderRadius: 16,
    backgroundColor: "#121212",
    borderWidth: 1,
    borderColor: "#222",
    marginBottom: 18
  },
  deviceTitle: {
    color: "#f0f0f0",
    fontSize: 14,
    fontWeight: "600"
  },
  deviceSubtitle: {
    color: "#8a8a8a",
    fontSize: 12,
    marginTop: 6
  },
  deviceButton: {
    backgroundColor: "#1e5dff",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999
  },
  deviceButtonText: {
    color: "#f5f5f5",
    fontSize: 12,
    fontWeight: "700"
  },
  cardsRow: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 24
  },
  card: {
    flex: 1,
    padding: 18,
    borderRadius: 18,
    backgroundColor: "#171717",
    borderWidth: 1,
    borderColor: "#262626"
  },
  cardAccent: {
    flex: 1,
    padding: 18,
    borderRadius: 18,
    backgroundColor: "#0c1f1c",
    borderWidth: 1,
    borderColor: "#1c5448"
  },
  cardLabel: {
    color: "#9d9d9d",
    fontSize: 12
  },
  cardValue: {
    color: "#f1f1f1",
    fontSize: 22,
    fontWeight: "700",
    marginTop: 6
  },
  cardHint: {
    color: "#6b6b6b",
    marginTop: 6,
    fontSize: 12
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
    marginTop: 22
  },
  sectionTitle: {
    color: "#f0f0f0",
    fontSize: 16,
    fontWeight: "600"
  },
  toggleAll: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#303030"
  },
  toggleAllText: {
    color: "#cfcfcf",
    fontSize: 12
  },
  list: {
    gap: 12
  },
  listItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderRadius: 16,
    backgroundColor: "#121212",
    borderWidth: 1,
    borderColor: "#222"
  },
  listText: {
    flex: 1,
    marginRight: 12
  },
  listTitle: {
    color: "#f3f3f3",
    fontSize: 15,
    fontWeight: "600"
  },
  listSubtitle: {
    color: "#8e8e8e",
    fontSize: 12,
    marginTop: 4
  },
  listMeta: {
    alignItems: "flex-end",
    gap: 8
  },
  listValue: {
    color: "#d9ffe9",
    fontSize: 13,
    fontWeight: "600"
  },
  actionPanel: {
    marginTop: 26,
    padding: 18,
    borderRadius: 18,
    backgroundColor: "#0f0f0f",
    borderWidth: 1,
    borderColor: "#2a2a2a",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  actionLabel: {
    color: "#9d9d9d",
    fontSize: 12
  },
  actionValue: {
    color: "#f6f6f6",
    fontSize: 20,
    fontWeight: "700"
  },
  cleanButton: {
    backgroundColor: "#00f5a0",
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 999
  },
  cleanButtonText: {
    color: "#0b0b0b",
    fontWeight: "700",
    fontSize: 14
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: "#1a1a1a",
    overflow: "hidden",
    marginTop: 14
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#00f5a0"
  },
  note: {
    marginTop: 16,
    color: "#9be7c4",
    fontSize: 12
  },
  error: {
    marginTop: 8,
    color: "#ff8a8a",
    fontSize: 12
  },
  debug: {
    marginTop: 8,
    color: "#8ad4ff",
    fontSize: 12
  },
  historyList: {
    gap: 10
  },
  historyItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#101010",
    borderWidth: 1,
    borderColor: "#1f1f1f"
  },
  historyTitle: {
    color: "#f0f0f0",
    fontSize: 13,
    fontWeight: "600"
  },
  historySubtitle: {
    color: "#7d7d7d",
    fontSize: 11,
    marginTop: 4
  },
  historyTag: {
    color: "#0b0b0b",
    backgroundColor: "#c9f7e2",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: "700"
  },
  historyEmpty: {
    color: "#6a6a6a",
    fontSize: 12
  }
});
