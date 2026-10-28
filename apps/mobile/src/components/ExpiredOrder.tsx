// The calm "This order expired" page, shared by Buy and Sell. No red, one
// clear next step, a short "already sent the money?" line, the old quote faded
// out, and what happened. Mirrors apps/web/src/app/components/arc/ui/ExpiredOrder.tsx.
import { View, Text, Linking, StyleSheet, type ViewProps } from "react-native";
import { Feather } from "@expo/vector-icons";
import { SUPPORT_EMAIL_URL } from "@/config/support";
import {
  Card,
  DetailRows,
  PrimaryButton,
  SecondaryButton,
  StepProgress,
  clockTime,
  kitStyles,
} from "./kit";
import { theme, z, zf } from "@/theme";

const c = theme.flow;

export function ExpiredOrder({
  steps,
  deadline,
  createdAt,
  againTitle,
  againSub,
  payLabel,
  payAmount,
  receiveLabel,
  receiveAmount,
  rateLine,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  quoteRows,
  orderId,
}: {
  steps: string[];
  deadline?: string | null;
  createdAt?: string | null;
  againTitle: string;
  againSub: string;
  payLabel: string;
  payAmount: string;
  receiveLabel: string;
  receiveAmount: string | null;
  rateLine?: string | null;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  quoteRows: { label: string; value: ViewProps["children"] }[];
  orderId?: string | null;
}) {
  const expiredTime = clockTime(deadline);
  const created = createdAt ? Date.parse(createdAt) : NaN;
  const expired = deadline ? Date.parse(deadline) : NaN;
  const waited =
    Number.isFinite(created) && Number.isFinite(expired)
      ? Math.round((expired - created) / 60000)
      : null;

  return (
    <>
      <StepProgress steps={steps} current={2} />

      <View style={s.head}>
        <View style={s.timer}>
          <Feather name="clock" size={22} color={c.inkSoft} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.title}>This order expired</Text>
          <Text style={s.sub}>
            No payment arrived{expiredTime ? ` before ${expiredTime}` : ""}, so the rate wasn&apos;t
            used. You haven&apos;t been charged.
          </Text>
        </View>
      </View>

      <Card primary>
        <Text style={kitStyles.cardTitle}>{againTitle}</Text>
        <Text style={kitStyles.small}>{againSub}</Text>
        <View style={s.again}>
          <View style={{ flex: 1 }}>
            <Text style={kitStyles.small}>{payLabel}</Text>
            <Text style={s.big}>{payAmount}</Text>
          </View>
          <Feather name="arrow-right" size={18} color={c.muted} />
          <View style={{ flex: 1, alignItems: "flex-end" }}>
            <Text style={kitStyles.small}>{receiveLabel}</Text>
            <Text style={s.big}>{receiveAmount ?? "…"}</Text>
            {rateLine ? <Text style={s.tiny}>{rateLine}</Text> : null}
          </View>
        </View>
        <PrimaryButton label={primaryLabel} onPress={onPrimary} arrow />
        {secondaryLabel && onSecondary ? (
          <SecondaryButton label={secondaryLabel} onPress={onSecondary} />
        ) : null}
      </Card>

      {/* Brief: a late transfer is refunded, don't send twice. */}
      <View style={s.already}>
        <Text style={kitStyles.small}>
          <Text style={s.strong}>Already sent the money? </Text>
          Don&apos;t send it again. It will be refunded.{" "}
          <Text style={s.link} onPress={() => void Linking.openURL(SUPPORT_EMAIL_URL)}>
            Contact support
          </Text>
        </Text>
      </View>

      {quoteRows.length > 0 && (
        <Card faded>
          <View style={s.quoteHead}>
            <Text style={[kitStyles.cardTitle, { color: c.inkSoft }]}>Expired quote</Text>
            <Text style={s.badge}>No longer valid</Text>
          </View>
          <DetailRows rows={quoteRows} />
        </Card>
      )}

      <Card>
        <Text style={kitStyles.cardTitle}>What happened</Text>
        <Step icon="check" done title="Rate locked" detail={`${clockTime(createdAt) ? `${clockTime(createdAt)} · ` : ""}payment details issued`} line />
        <Step title="No payment received" detail={waited ? `Waited ${waited} minutes` : "Nothing arrived in time"} line />
        <Step icon="x" dark title="Order expired" detail={`${expiredTime ? `${expiredTime} · ` : ""}nothing was charged`} />
        {orderId ? (
          <Text style={s.order} selectable>
            Order {orderId.length > 14 ? `${orderId.slice(0, 8)}…${orderId.slice(-4)}` : orderId}
          </Text>
        ) : null}
      </Card>
    </>
  );
}

function Step({
  icon,
  done,
  dark,
  title,
  detail,
  line,
}: {
  icon?: "check" | "x";
  done?: boolean;
  dark?: boolean;
  title: string;
  detail: string;
  line?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ alignItems: "center" }}>
        <View
          style={[
            s.dot,
            done && { backgroundColor: c.success },
            dark && { backgroundColor: c.inkSoft },
            !done && !dark && s.dotTodo,
          ]}
        >
          {icon ? <Feather name={icon} size={12} color="#fff" /> : null}
        </View>
        {line && <View style={[s.line, done && { backgroundColor: c.success }]} />}
      </View>
      <View style={{ flex: 1, gap: 2, paddingBottom: line ? 14 : 0 }}>
        <Text style={s.stepTitle}>{title}</Text>
        <Text style={kitStyles.small}>{detail}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", gap: z(14), alignItems: "flex-start" },
  timer: {
    width: z(48),
    height: z(48),
    borderRadius: z(16),
    backgroundColor: c.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: c.ink, fontSize: zf(24), fontWeight: "600", letterSpacing: -0.4 },
  sub: { color: c.muted, fontSize: zf(14), lineHeight: z(20) },
  again: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(12),
    borderRadius: z(16),
    backgroundColor: c.page,
    padding: z(14),
  },
  big: { color: c.ink, fontSize: zf(19), fontWeight: "600" },
  tiny: { color: c.muted, fontSize: zf(11) },
  already: { borderRadius: z(16), backgroundColor: c.subtle, padding: z(14) },
  strong: { color: c.ink, fontWeight: "600" },
  link: { color: c.ink, fontWeight: "600", textDecorationLine: "underline" },
  quoteHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  badge: {
    color: c.inkSoft,
    fontSize: zf(12),
    fontWeight: "600",
    backgroundColor: c.chip,
    paddingHorizontal: z(10),
    paddingVertical: z(4),
    borderRadius: z(999),
    overflow: "hidden",
  },
  dot: { width: z(24), height: z(24), borderRadius: z(12), alignItems: "center", justifyContent: "center" },
  dotTodo: { borderWidth: 2, borderColor: c.stepRing },
  line: { flex: 1, width: z(2), minHeight: z(16), backgroundColor: c.edge },
  stepTitle: { color: c.ink, fontSize: zf(14), fontWeight: "600" },
  order: { color: c.muted, fontSize: zf(13), fontFamily: "Menlo" },
});
