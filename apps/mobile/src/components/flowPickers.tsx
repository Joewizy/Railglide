// The two pickers on the Buy/Sell amount screens, built on PickerSheet:
// token + chain (USDC/USDT switch, then every chain with its logo) and
// currency (flag, country, currency). Mirrors the website's sendPickers.tsx.
import { View, Text, Pressable, StyleSheet, type ViewProps } from "react-native";
import { PickerSheet, type SheetItem } from "./PickerSheet";
import { TokenLogo } from "./Logo";
import { theme, z, zf } from "@/theme";

const c = theme.flow;

export function TokenChainSheet({
  open,
  onClose,
  title,
  hint,
  token,
  tokens,
  onTokenChange,
  chains,
  value,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  hint?: string;
  token: string;
  tokens: readonly string[];
  onTokenChange: (t: string) => void;
  chains: { value: string; label: string; logo: ViewProps["children"] }[];
  value: string;
  onSelect: (value: string) => void;
}) {
  const intro = (
    <View style={{ gap: 8 }}>
      {tokens.length > 1 && (
        <View style={s.toggle} accessibilityRole="radiogroup">
          {tokens.map((t) => (
            <Pressable
              key={t}
              onPress={() => onTokenChange(t)}
              style={[s.toggleBtn, token === t && s.toggleOn]}
              accessibilityRole="radio"
              accessibilityState={{ checked: token === t }}
            >
              <TokenLogo symbol={t} size={18} />
              <Text style={[s.toggleText, token === t && s.toggleTextOn]}>{t}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      title={title}
      intro={intro}
      value={value}
      onSelect={onSelect}
      groups={[
        {
          label: "Chain",
          items: chains.map((ch) => ({
            value: ch.value,
            title: ch.label,
            logo: <View style={s.logo}>{ch.logo}</View>,
          })),
        },
      ]}
    />
  );
}

export type CurrencyOption = {
  value: string;
  flag: string;
  country: string;
  code: string;
  name: string;
};

export function CurrencySheet({
  open,
  onClose,
  title,
  value,
  popular,
  others = [],
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  value: string;
  popular: CurrencyOption[];
  others?: CurrencyOption[];
  onSelect: (o: CurrencyOption) => void;
}) {
  const toItem = (o: CurrencyOption): SheetItem => ({
    value: o.value,
    title: o.country,
    subtitle: o.name,
    trailing: o.code,
    logo: <Text style={s.flag}>{o.flag}</Text>,
  });
  const all = [...popular, ...others];
  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      title={title}
      value={value}
      searchPlaceholder="Search country or currency"
      onSelect={(v) => {
        const o = all.find((x) => x.value === v);
        if (o) onSelect(o);
      }}
      groups={[
        { label: "Popular", items: popular.map(toItem) },
        {
          label: "All countries",
          items: [...others].sort((a, b) => a.country.localeCompare(b.country)).map(toItem),
        },
      ]}
    />
  );
}

const s = StyleSheet.create({
  toggle: { flexDirection: "row", gap: z(4), padding: z(4), borderRadius: z(14), backgroundColor: c.page },
  toggleBtn: {
    flex: 1,
    height: z(44),
    borderRadius: z(10),
    flexDirection: "row",
    gap: z(8),
    alignItems: "center",
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: c.card, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  toggleText: { color: c.muted, fontSize: zf(14), fontWeight: "600" },
  toggleTextOn: { color: c.ink },
  hint: { color: c.muted, fontSize: zf(13), lineHeight: z(18) },
  logo: { width: z(32), height: z(32), alignItems: "center", justifyContent: "center" },
  flag: { fontSize: zf(26), width: z(32), textAlign: "center" },
});
