// Shared pieces for the Buy and Sell screens, matching the website's redesign
// (apps/web/src/app/components/arc/ui/sendKit.tsx) with the same palette
// (theme.flow): warm page, white 20px cards, ink buttons, sentence-case labels,
// 48px+ touch targets. Monospace only for addresses.
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  type ViewProps,
  type TextInputProps,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Svg, { Rect } from "react-native-svg";
import QRCode from "qrcode";
import { copyToClipboard } from "@/lib/clipboard";
import { theme, z, zf } from "@/theme";

const c = theme.flow;
const mono = "Menlo";

/* ── Layout ─────────────────────────────────────────────────────────────── */

/** Scrolling page with an optional Back link. (No Buy/Sell tag on mobile —
 *  the tab bar already says which one you're on.) */
export function FlowScreen({
  onBack,
  backLabel = "Back",
  children,
}: {
  onBack?: () => void;
  backLabel?: string;
  children: ViewProps["children"];
}) {
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.screenContent}
      keyboardShouldPersistTaps="handled"
      // Keep fields reachable above the keyboard (iOS) and let a drag close it.
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="on-drag"
    >
      {onBack && (
        <Pressable onPress={onBack} hitSlop={8} style={s.back}>
          <Feather name="chevron-left" size={18} color={c.inkSoft} />
          <Text style={s.backText}>{backLabel}</Text>
        </Pressable>
      )}
      {children}
    </ScrollView>
  );
}

export function FlowHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={s.header}>
      <Text style={s.title}>{title}</Text>
      {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

/** Numbered steps; earlier ones get a green check. */
export function StepProgress({ steps, current }: { steps: string[]; current: number }) {
  return (
    <View style={s.steps}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <View key={label} style={s.stepWrap}>
            {i > 0 && <View style={[s.stepLine, (done || active) && s.stepLineDone]} />}
            <View style={s.step}>
              {done ? (
                <View style={[s.stepDot, s.stepDone]}>
                  <Feather name="check" size={11} color="#fff" />
                </View>
              ) : active ? (
                <View style={[s.stepDot, s.stepActive]}>
                  <Text style={s.stepNumActive}>{i + 1}</Text>
                </View>
              ) : (
                <View style={[s.stepDot, s.stepTodo]}>
                  <Text style={s.stepNum}>{i + 1}</Text>
                </View>
              )}
              <Text style={[s.stepLabel, active && s.stepLabelActive]}>{label}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** White card; `primary` gets the dark border for the card to act on. */
export function Card({
  children,
  primary = false,
  faded = false,
  style,
}: {
  children: ViewProps["children"];
  primary?: boolean;
  faded?: boolean;
  style?: ViewProps["style"];
}) {
  return (
    <View style={[s.card, primary && s.cardPrimary, faded && s.faded, style]}>
      {children}
    </View>
  );
}

/* ── Amount fields ──────────────────────────────────────────────────────── */

export function AmountCard({
  label,
  value,
  onChange,
  readOnly = false,
  prefix,
  aside,
  pill,
  children,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  /** Muted text before the number, e.g. "≈" on an estimate. */
  prefix?: string;
  aside?: ViewProps["children"];
  pill?: ViewProps["children"];
  children?: ViewProps["children"];
}) {
  return (
    <View style={s.amountCard}>
      <View style={s.amountTop}>
        <Text style={s.amountLabel}>{label}</Text>
        {aside}
      </View>
      <View style={s.amountRow}>
        {prefix && value ? <Text style={s.amountPrefix}>{prefix}</Text> : null}
        <TextInput
          style={s.amountInput}
          value={value}
          editable={!readOnly}
          onChangeText={(t) => onChange?.(t.replace(/[^0-9.]/g, ""))}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={c.placeholder}
        />
        {pill}
      </View>
      {children}
    </View>
  );
}

/** "Balance 1,240.50 USDC · Max" — Max hides at 0. */
export function BalanceAside({
  label,
  showMax,
  onMax,
}: {
  label: string;
  showMax: boolean;
  onMax: () => void;
}) {
  return (
    <View style={s.balanceAside}>
      <Text style={s.small}>Balance {label}</Text>
      {showMax && (
        <Pressable onPress={onMax} style={s.maxChip} hitSlop={6}>
          <Text style={s.maxText}>Max</Text>
        </Pressable>
      )}
    </View>
  );
}

/** "USDC on Base" pill with the chain badge on the token logo. */
export function TokenChainPill({
  token,
  chainName,
  tokenLogo,
  chainLogo,
  onPress,
}: {
  token: string;
  chainName: string;
  tokenLogo: ViewProps["children"];
  chainLogo?: ViewProps["children"];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={s.pill}
      accessibilityLabel={`Change token or chain, currently ${token} on ${chainName}`}
    >
      <View style={s.pillLogo}>
        {tokenLogo}
        {chainLogo ? <View style={s.pillBadge}>{chainLogo}</View> : null}
      </View>
      <View>
        <Text style={s.pillTitle}>{token}</Text>
        <Text style={s.pillSub}>on {chainName}</Text>
      </View>
      <Feather name="chevron-down" size={16} color={c.muted} />
    </Pressable>
  );
}

/** "🇳🇬 NGN · Nigeria" pill. */
export function CurrencyPill({
  flag,
  code,
  country,
  onPress,
}: {
  flag: string;
  code: string;
  country: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={s.pill} accessibilityLabel={`Change currency, currently ${code}`}>
      <Text style={s.flag}>{flag}</Text>
      <View>
        <Text style={s.pillTitle}>{code}</Text>
        <Text style={s.pillSub}>{country}</Text>
      </View>
      <Feather name="chevron-down" size={16} color={c.muted} />
    </Pressable>
  );
}

/** "1 USDC = 1,375.32 NGN" between the two amount cards. */
export function RateLine({
  rate,
  approximate = false,
}: {
  rate: { from: string; to: string } | null;
  approximate?: boolean;
}) {
  return (
    <View style={s.rateLine}>
      <Feather name="refresh-cw" size={13} color={c.muted} />
      {rate ? (
        <Text style={s.small}>
          {rate.from} {approximate ? "≈" : "="}{" "}
          <Text style={s.strong}>{rate.to}</Text>
        </Text>
      ) : (
        <Text style={s.small}>Fetching the live rate…</Text>
      )}
    </View>
  );
}

/* ── Rows, buttons, notices ─────────────────────────────────────────────── */

export type SummaryRow = { label: string; value: string; total?: boolean };

export function SummaryRows({ rows }: { rows: SummaryRow[] }) {
  return (
    <View style={s.summary}>
      {rows.map((r) => (
        <View key={r.label} style={[s.summaryRow, r.total && s.summaryTotal]}>
          <Text style={r.total ? s.summaryLabelTotal : s.summaryLabel}>{r.label}</Text>
          <Text style={r.total ? s.summaryValueTotal : s.summaryValue}>{r.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** Label / value rows inside a card (quote, order details). */
export function DetailRows({
  rows,
}: {
  rows: { label: string; value: ViewProps["children"] }[];
}) {
  return (
    <View>
      {rows.map((r, i) => (
        <View key={r.label} style={[s.detailRow, i < rows.length - 1 && s.detailBorder]}>
          <Text style={s.detailLabel}>{r.label}</Text>
          {typeof r.value === "string" ? (
            <Text style={s.detailValue}>{r.value}</Text>
          ) : (
            r.value
          )}
        </View>
      ))}
    </View>
  );
}

/** The main button. When it can't proceed, the label says why. */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  arrow = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  arrow?: boolean;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [s.primary, off && s.primaryOff, pressed && !off && s.pressed]}
    >
      {loading && <ActivityIndicator size="small" color={c.muted} />}
      <Text style={[s.primaryText, off && s.primaryTextOff]}>{label}</Text>
      {arrow && !off && <Feather name="arrow-right" size={18} color="#fff" />}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.secondary, pressed && s.pressed]}>
      <Text style={s.secondaryText}>{label}</Text>
    </Pressable>
  );
}

export function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={s.link}>{label}</Text>
    </Pressable>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "error" | "info";
  title?: string;
  children?: ViewProps["children"];
}) {
  if (tone === "error") {
    return (
      <View style={s.noticeError}>
        <Feather name="alert-circle" size={15} color={c.danger} />
        <Text style={s.noticeErrorText}>
          {title ? <Text style={s.strongDanger}>{title} </Text> : null}
          {children}
        </Text>
      </View>
    );
  }
  return (
    <View style={[s.notice, tone === "info" && s.noticeInfo]}>
      <Text style={[s.noticeText, tone === "info" && s.noticeInfoText]}>
        {title ? <Text style={s.strong}>{title} </Text> : null}
        {children}
      </Text>
    </View>
  );
}

/* ── Inputs ─────────────────────────────────────────────────────────────── */

export function FieldLabel({ children }: { children: string }) {
  return <Text style={s.fieldLabel}>{children}</Text>;
}

export function TextField({
  mono: isMono,
  ref,
  ...props
}: TextInputProps & { mono?: boolean; ref?: React.Ref<TextInput> }) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={c.muted}
      autoCorrect={false}
      {...props}
      style={[s.input, isMono && s.inputMono, props.style]}
    />
  );
}

/** A field-looking button that opens a picker. */
export function SelectField({
  value,
  placeholder,
  onPress,
  logo,
  trailing,
}: {
  value?: string;
  placeholder: string;
  onPress: () => void;
  logo?: ViewProps["children"];
  trailing?: string;
}) {
  return (
    <Pressable onPress={onPress} style={s.select}>
      {logo}
      <Text style={value ? s.selectText : s.selectPlaceholder} numberOfLines={1}>
        {value ?? placeholder}
      </Text>
      {trailing ? <Text style={s.small}>{trailing}</Text> : null}
      <Feather name="chevron-down" size={16} color={c.muted} />
    </Pressable>
  );
}

/** A labelled value with a Copy button. */
export function CopyRow({
  label,
  value,
  copyText,
  mono: isMono = false,
}: {
  label: string;
  value: string;
  copyText: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.small}>{label}</Text>
      <View style={s.copyRow}>
        <Text style={[isMono ? s.copyMono : s.copyValue]} selectable>
          {value}
        </Text>
        <Pressable
          onPress={async () => {
            if (await copyToClipboard(copyText)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          style={s.copyBtn}
          accessibilityLabel={`Copy ${label.toLowerCase()}`}
        >
          <Feather name={copied ? "check" : "copy"} size={13} color={c.ink} />
          <Text style={s.copyBtnText}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Done = green check, current = ringed dot, later = grey ring. */
export function ProgressList({
  stages,
  activeIndex,
  done = false,
  failed = false,
}: {
  stages: { l: string; d: string }[];
  activeIndex: number;
  done?: boolean;
  failed?: boolean;
}) {
  return (
    <View>
      {stages.map((st, i) => {
        const isDone = done || activeIndex > i;
        const isActive = !done && activeIndex === i;
        const last = i === stages.length - 1;
        return (
          <View key={i} style={s.progRow}>
            <View style={s.progRail}>
              {failed && isActive ? (
                <View style={[s.progDot, { backgroundColor: c.danger }]}>
                  <Text style={s.progBang}>!</Text>
                </View>
              ) : isDone ? (
                <View style={[s.progDot, { backgroundColor: c.success }]}>
                  <Feather name="check" size={12} color="#fff" />
                </View>
              ) : isActive ? (
                <View style={[s.progDot, s.progActive]}>
                  <View style={s.progInner} />
                </View>
              ) : (
                <View style={[s.progDot, s.progTodo]} />
              )}
              {!last && <View style={[s.progLine, isDone && { backgroundColor: c.success }]} />}
            </View>
            <View style={[s.progText, !last && { paddingBottom: 18 }]}>
              <Text style={[s.progTitle, !(isDone || isActive) && { color: c.inkSoft, fontWeight: "500" }]}>
                {st.l}
              </Text>
              <Text style={s.small}>{st.d}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** QR code for a deposit address (drawn with react-native-svg). */
export function QrCode({ value, size = 128 }: { value: string; size?: number }) {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = size / n;
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) cells.push({ x, y });
  return (
    <View style={s.qr}>
      <Svg width={size} height={size}>
        <Rect width={size} height={size} fill="#fff" />
        {cells.map(({ x, y }) => (
          <Rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell + 0.3} height={cell + 0.3} fill={c.ink} />
        ))}
      </Svg>
    </View>
  );
}

/** "0xa279…7FE1". */
export function short0x(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** "2026-10-27T18:44:29Z" → "6:44 PM" (device locale). */
export function clockTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/* ── Styles ─────────────────────────────────────────────────────────────── */

export const kitStyles = StyleSheet.create({
  small: { color: c.muted, fontSize: zf(13), lineHeight: z(19) },
  mono: { fontFamily: mono, fontSize: zf(13), color: c.ink },
  cardTitle: { color: c.ink, fontSize: zf(17), fontWeight: "600" },
  gap: { gap: z(theme.spacing(1.5)) },
});

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.page },
  screenContent: { padding: z(theme.spacing(2)), paddingBottom: z(theme.spacing(6)), gap: z(theme.spacing(1.5)) },
  back: { flexDirection: "row", alignItems: "center", gap: z(2), alignSelf: "flex-start", minHeight: z(36) },
  backText: { color: c.inkSoft, fontSize: zf(14), fontWeight: "500" },
  header: { gap: z(4) },
  title: { color: c.ink, fontSize: zf(26), fontWeight: "600", letterSpacing: -0.4 },
  subtitle: { color: c.muted, fontSize: zf(14), lineHeight: z(20) },

  steps: { flexDirection: "row", alignItems: "center", marginVertical: z(theme.spacing(0.5)) },
  stepWrap: { flexDirection: "row", alignItems: "center", flex: 1 },
  stepLine: { flex: 1, height: z(1), backgroundColor: c.stepLine, marginHorizontal: z(6) },
  stepLineDone: { backgroundColor: c.success },
  step: { flexDirection: "row", alignItems: "center", gap: z(6) },
  stepDot: { width: z(20), height: z(20), borderRadius: z(10), alignItems: "center", justifyContent: "center" },
  stepDone: { backgroundColor: c.success },
  stepActive: { backgroundColor: c.ink },
  stepTodo: { borderWidth: 1, borderColor: c.stepRing },
  stepNum: { color: c.muted, fontSize: zf(11), fontWeight: "600" },
  stepNumActive: { color: "#fff", fontSize: zf(11), fontWeight: "600" },
  stepLabel: { color: c.muted, fontSize: zf(13), fontWeight: "500" },
  stepLabelActive: { color: c.ink },

  card: {
    backgroundColor: c.card,
    borderRadius: z(theme.radius.cardLg),
    borderWidth: 1,
    borderColor: c.edge,
    paddingHorizontal: z(theme.spacing(2)),
    paddingVertical: z(theme.spacing(2)),
    gap: z(theme.spacing(1.5)),
  },
  cardPrimary: { borderWidth: 2, borderColor: c.ink },
  faded: { opacity: 0.6 },

  amountCard: {
    backgroundColor: c.card,
    borderRadius: z(theme.radius.cardLg),
    borderWidth: 1,
    borderColor: c.edge,
    paddingHorizontal: z(theme.spacing(2)),
    paddingTop: z(theme.spacing(1.75)),
    paddingBottom: z(theme.spacing(1.5)),
    gap: z(theme.spacing(0.75)),
  },
  amountTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: z(20) },
  amountLabel: { color: c.muted, fontSize: zf(13), fontWeight: "500" },
  amountRow: { flexDirection: "row", alignItems: "center", gap: z(theme.spacing(1)) },
  amountPrefix: { color: c.muted, fontSize: zf(28), fontWeight: "600" },
  amountInput: { flex: 1, minWidth: 0, color: c.ink, fontSize: zf(34), fontWeight: "600", paddingVertical: z(4) },
  balanceAside: { flexDirection: "row", alignItems: "center", gap: z(8) },
  maxChip: { height: z(28), paddingHorizontal: z(12), borderRadius: z(999), backgroundColor: c.chip, justifyContent: "center" },
  maxText: { color: c.ink, fontSize: zf(12), fontWeight: "600" },

  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(8),
    height: z(48),
    paddingLeft: z(8),
    paddingRight: z(10),
    borderRadius: z(999),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.pill,
  },
  pillLogo: { width: z(28), height: z(28) },
  pillBadge: {
    position: "absolute",
    right: z(-3),
    bottom: z(-3),
    width: z(15),
    height: z(15),
    borderRadius: z(8),
    overflow: "hidden",
    borderWidth: 2,
    borderColor: c.pill,
    backgroundColor: c.card,
    alignItems: "center",
    justifyContent: "center",
  },
  pillTitle: { color: c.ink, fontSize: zf(14), fontWeight: "600", lineHeight: z(17) },
  pillSub: { color: c.muted, fontSize: zf(11), lineHeight: z(14) },
  flag: { fontSize: zf(22) },

  rateLine: { flexDirection: "row", alignItems: "center", gap: z(6), paddingHorizontal: z(4), minHeight: z(32) },
  small: { color: c.muted, fontSize: zf(13), lineHeight: z(19) },
  strong: { color: c.ink, fontWeight: "600" },
  strongDanger: { color: c.danger, fontWeight: "600" },

  summary: {
    borderRadius: z(16),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.subtle,
    paddingHorizontal: z(theme.spacing(2)),
    paddingVertical: z(theme.spacing(1.5)),
    gap: z(theme.spacing(1.25)),
  },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", gap: z(12) },
  summaryTotal: { borderTopWidth: 1, borderTopColor: c.edge, paddingTop: z(theme.spacing(1.25)) },
  summaryLabel: { color: c.muted, fontSize: zf(14) },
  summaryValue: { color: c.ink, fontSize: zf(14), fontWeight: "500" },
  summaryLabelTotal: { color: c.ink, fontSize: zf(14), fontWeight: "500" },
  summaryValueTotal: { color: c.ink, fontSize: zf(14), fontWeight: "600" },

  detailRow: { flexDirection: "row", justifyContent: "space-between", gap: z(16), paddingVertical: z(10) },
  detailBorder: { borderBottomWidth: 1, borderBottomColor: c.edgeSoft },
  detailLabel: { color: c.muted, fontSize: zf(14) },
  detailValue: { color: c.ink, fontSize: zf(14), fontWeight: "500", flexShrink: 1, textAlign: "right" },

  primary: {
    flexDirection: "row",
    gap: z(8),
    height: z(52),
    borderRadius: z(theme.radius.button),
    backgroundColor: c.ink,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: z(theme.spacing(2)),
  },
  primaryOff: { backgroundColor: c.disabled },
  primaryText: { color: "#fff", fontSize: zf(16), fontWeight: "600" },
  primaryTextOff: { color: c.muted },
  pressed: { opacity: 0.85 },
  secondary: {
    height: z(48),
    borderRadius: z(theme.radius.button),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.card,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: z(theme.spacing(2)),
  },
  secondaryText: { color: c.ink, fontSize: zf(15), fontWeight: "600" },
  link: { color: c.ink, fontSize: zf(14), fontWeight: "600", textDecorationLine: "underline" },

  notice: { borderRadius: z(14), backgroundColor: c.warnBg, padding: z(12) },
  noticeText: { color: c.warnInk, fontSize: zf(13), lineHeight: z(19) },
  noticeInfo: { backgroundColor: c.subtle },
  noticeInfoText: { color: c.muted },
  noticeError: { flexDirection: "row", gap: z(6), alignItems: "flex-start" },
  noticeErrorText: { flex: 1, color: c.danger, fontSize: zf(13), lineHeight: z(19) },

  fieldLabel: { color: c.muted, fontSize: zf(13), fontWeight: "500" },
  input: {
    height: z(48),
    borderRadius: z(theme.radius.field),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.card,
    paddingHorizontal: z(14),
    color: c.ink,
    fontSize: zf(15),
  },
  inputMono: { fontFamily: mono, fontSize: zf(13) },
  select: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(12),
    height: z(48),
    borderRadius: z(theme.radius.field),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.card,
    paddingHorizontal: z(14),
  },
  selectText: { flex: 1, color: c.ink, fontSize: zf(15), fontWeight: "500" },
  selectPlaceholder: { flex: 1, color: c.muted, fontSize: zf(15) },

  copyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(12),
    borderRadius: z(14),
    backgroundColor: c.page,
    paddingHorizontal: z(14),
    paddingVertical: z(10),
  },
  copyValue: { flex: 1, color: c.ink, fontSize: zf(15), fontWeight: "600" },
  copyMono: { flex: 1, color: c.ink, fontSize: zf(13), fontFamily: mono },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(6),
    height: z(36),
    paddingHorizontal: z(12),
    borderRadius: z(999),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.card,
  },
  copyBtnText: { color: c.ink, fontSize: zf(13), fontWeight: "600" },

  progRow: { flexDirection: "row", gap: z(12) },
  progRail: { alignItems: "center" },
  progDot: { width: z(24), height: z(24), borderRadius: z(12), alignItems: "center", justifyContent: "center" },
  progActive: { borderWidth: 2, borderColor: c.ink },
  progInner: { width: z(8), height: z(8), borderRadius: z(4), backgroundColor: c.ink },
  progTodo: { borderWidth: 2, borderColor: c.stepRing },
  progBang: { color: "#fff", fontSize: zf(12), fontWeight: "700" },
  progLine: { flex: 1, width: z(2), minHeight: z(20), backgroundColor: c.edge },
  progText: { flex: 1, gap: z(2) },
  progTitle: { color: c.ink, fontSize: zf(14), fontWeight: "600" },

  qr: { padding: z(8), borderRadius: z(12), borderWidth: 1, borderColor: c.edge, backgroundColor: "#fff" },
});
