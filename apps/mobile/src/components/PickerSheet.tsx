// Bottom-sheet picker from the redesign: title, optional search, optional
// content above the list (e.g. the USDC/USDT switch), grouped rows with a logo,
// title, subtitle and right-hand text. Opened by whatever trigger the screen
// draws (a pill, a field…). Mirrors apps/web/src/app/components/arc/ui/PickerSheet.tsx.
import { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  type ViewProps,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { theme, z, zf } from "@/theme";

const c = theme.flow;

export type SheetItem = {
  value: string;
  title: string;
  subtitle?: string;
  /** Right-hand text, e.g. "NGN". */
  trailing?: string;
  logo?: ViewProps["children"];
  /** Extra words the search should match. */
  keywords?: string;
};

export type SheetGroup = { label?: string; items: SheetItem[] };

export function PickerSheet({
  open,
  onClose,
  title,
  groups,
  value,
  onSelect,
  searchPlaceholder,
  intro,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  groups: SheetGroup[];
  value?: string;
  onSelect: (value: string) => void;
  /** Shows a search box when set. */
  searchPlaceholder?: string;
  /** Content above the list. */
  intro?: ViewProps["children"];
}) {
  const [query, setQuery] = useState("");

  // Search flattens the groups into one result list, without duplicates.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups.filter((g) => g.items.length);
    const seen = new Set<string>();
    const hits = groups
      .flatMap((g) => g.items)
      .filter((i) => {
        if (seen.has(i.value)) return false;
        const text = [i.title, i.subtitle, i.trailing, i.keywords, i.value]
          .join(" ")
          .toLowerCase();
        if (!text.includes(q)) return false;
        seen.add(i.value);
        return true;
      });
    return hits.length ? [{ label: "Results", items: hits }] : [];
  }, [groups, query]);

  const close = () => {
    setQuery("");
    onClose();
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={close} hitSlop={10} accessibilityLabel="Close">
            <Feather name="x" size={22} color={c.ink} />
          </Pressable>
        </View>

        {intro && <View style={styles.intro}>{intro}</View>}

        {searchPlaceholder && (
          <View style={styles.search}>
            <Feather name="search" size={18} color={c.muted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              placeholderTextColor={c.muted}
              autoCorrect={false}
            />
          </View>
        )}

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {visible.length === 0 && (
            <Text style={styles.empty}>No matches for “{query}”.</Text>
          )}
          {visible.map((g, gi) => (
            <View key={`${g.label ?? ""}-${gi}`}>
              {g.label && <Text style={styles.groupLabel}>{g.label}</Text>}
              {g.items.map((item) => {
                const selected = item.value === value;
                return (
                  <Pressable
                    key={`${g.label ?? ""}-${item.value}`}
                    style={({ pressed }) => [
                      styles.row,
                      (pressed || selected) && styles.rowActive,
                    ]}
                    onPress={() => {
                      onSelect(item.value);
                      close();
                    }}
                  >
                    {item.logo}
                    <View style={styles.rowMain}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      {item.subtitle && (
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {item.subtitle}
                        </Text>
                      )}
                    </View>
                    {item.trailing && (
                      <Text style={styles.rowTrailing}>{item.trailing}</Text>
                    )}
                    {selected && <Feather name="check" size={18} color={c.ink} />}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(23,23,26,0.45)" },
  sheet: {
    position: "absolute",
    left: z(0),
    right: z(0),
    bottom: z(0),
    height: "88%",
    backgroundColor: c.card,
    borderTopLeftRadius: z(24),
    borderTopRightRadius: z(24),
    paddingBottom: z(theme.spacing(4)),
  },
  grabber: {
    alignSelf: "center",
    width: z(36),
    height: z(4),
    borderRadius: z(2),
    backgroundColor: "#D8D3C8",
    marginTop: z(theme.spacing(1)),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: z(theme.spacing(2.5)),
    paddingTop: z(theme.spacing(1.5)),
    paddingBottom: z(theme.spacing(1)),
  },
  title: { color: c.ink, fontSize: zf(18), fontWeight: "600" },
  intro: { paddingHorizontal: z(theme.spacing(2.5)), paddingBottom: z(theme.spacing(1)) },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(theme.spacing(1.25)),
    marginHorizontal: z(theme.spacing(2.5)),
    marginBottom: z(theme.spacing(0.5)),
    height: z(48),
    paddingHorizontal: z(theme.spacing(1.75)),
    borderRadius: z(theme.radius.field),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.page,
  },
  searchInput: { flex: 1, color: c.ink, fontSize: zf(15) },
  list: { flex: 1 },
  empty: {
    color: c.muted,
    fontSize: zf(14),
    paddingHorizontal: z(theme.spacing(2.5)),
    paddingVertical: z(theme.spacing(3)),
  },
  groupLabel: {
    color: c.muted,
    fontSize: zf(13),
    fontWeight: "600",
    paddingHorizontal: z(theme.spacing(2.5)),
    paddingTop: z(theme.spacing(1.75)),
    paddingBottom: z(theme.spacing(0.5)),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(theme.spacing(1.75)),
    minHeight: z(60),
    paddingHorizontal: z(theme.spacing(2.5)),
  },
  rowActive: { backgroundColor: c.page },
  rowMain: { flex: 1, gap: z(2) },
  rowTitle: { color: c.ink, fontSize: zf(15), fontWeight: "600" },
  rowSub: { color: c.muted, fontSize: zf(13) },
  rowTrailing: { color: c.muted, fontSize: zf(14), fontWeight: "600" },
});
