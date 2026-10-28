import { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Linking,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type {
  ChatMessage,
  ChatReply,
  FlowId,
} from "@railglide/shared/assistant/types";
import { sendChat } from "@/api/chat";
import { ApiError } from "@/api/client";
import { useSession } from "@/store/session";
import { theme } from "@/theme";
import { SUPPORT_EMAIL, SUPPORT_EMAIL_URL } from "@/config/support";
import type { RootTabParamList } from "@/navigation/RootNavigator";

const FLOW_CTA: Record<FlowId, string> = {
  cashout: "Continue to sell",
  buy: "Buy crypto",
  bridge: "Continue",
};

const SUGGESTIONS = [
  "Sell 300 USDT for M-Pesa",
  "Swap XRP for USDC on Base",
  "How can I buy USDC on Arbitrum?",
];

// Intent chat. Posts to /api/chat; on a `ready` reply, stashes the FlowLaunch
// and hands off to the matching flow screen.
export function IntentScreen() {
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const setPendingLaunch = useSession((s) => s.setPendingLaunch);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReply, setLastReply] = useState<ChatReply | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setError(null);
    setLastReply(null);
    setThinking(true);
    try {
      const reply = await sendChat(next);
      setMessages([...next, { role: "assistant", content: reply.message }]);
      setLastReply(reply);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't reach the assistant — check your connection."
      );
    } finally {
      setThinking(false);
    }
  };

  const startOver = () => {
    setMessages([]);
    setLastReply(null);
    setError(null);
    setInput("");
  };

  const handoff = () => {
    if (!lastReply?.launch) return;
    const firstUser = messages.find((m) => m.role === "user")?.content;
    setPendingLaunch({
      ...lastReply.launch,
      plan: lastReply.plan.length ? lastReply.plan : lastReply.launch.plan,
      chatSummary: firstUser,
    });
    const tab: Record<FlowId, keyof RootTabParamList> = {
      cashout: "Sell",
      buy: "Buy",
      bridge: "Sell",
    };
    navigation.navigate(tab[lastReply.launch.flow]);
  };

  const empty = messages.length === 0 && !thinking;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.flex}>
        {messages.length > 0 && (
          <Pressable style={styles.startOver} onPress={startOver}>
            <Feather name="rotate-ccw" size={13} color={theme.colors.muted} />
            <Text style={styles.startOverText}>Start over</Text>
          </Pressable>
        )}

        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: true })
          }
          keyboardShouldPersistTaps="handled"
        >
          {empty && (
            <View style={styles.hero}>
              <Text style={styles.heroTitle}>What do you{"\n"}want to do?</Text>
              <Text style={styles.heroSub}>
                Sell crypto to a bank or mobile money, or buy crypto — just say
                it in plain words.
              </Text>
              <View style={styles.pills}>
                {SUGGESTIONS.map((s) => (
                  <Pressable
                    key={s}
                    style={({ pressed }) => [
                      styles.pill,
                      pressed && styles.pillPressed,
                    ]}
                    onPress={() => void send(s)}
                  >
                    <Text style={styles.pillText}>{s}</Text>
                    <Feather
                      name="arrow-up-right"
                      size={15}
                      color={theme.colors.accent}
                    />
                  </Pressable>
                ))}
              </View>
              {/* How to reach us */}
              <Text style={styles.contact}>
                Need help? Email{" "}
                <Text style={styles.contactLink} onPress={() => void Linking.openURL(SUPPORT_EMAIL_URL)}>
                  {SUPPORT_EMAIL}
                </Text>
                .
              </Text>
            </View>
          )}

          {messages.map((m, i) => (
            <View
              key={i}
              style={[
                styles.bubble,
                m.role === "user" ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              <Text
                style={m.role === "user" ? styles.userText : styles.assistantText}
              >
                {m.content}
              </Text>
            </View>
          ))}

          {thinking && (
            <View style={styles.thinkingRow}>
              <ActivityIndicator size="small" color={theme.colors.accent} />
              <Text style={styles.thinkingText}>Thinking…</Text>
            </View>
          )}

          {error && (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {lastReply?.launch && (
            <View style={styles.handoffCard}>
              {lastReply.plan.length > 0 && (
                <View style={styles.planList}>
                  {lastReply.plan.map((step, i) => (
                    <View key={i} style={styles.planRow}>
                      <Text style={styles.planNum}>{i + 1}</Text>
                      <Text style={styles.planStep}>{step}</Text>
                    </View>
                  ))}
                </View>
              )}
              <Pressable
                style={({ pressed }) => [
                  styles.ctaButton,
                  pressed && styles.pressed,
                ]}
                onPress={handoff}
              >
                <Text style={styles.ctaText}>
                  {FLOW_CTA[lastReply.launch.flow]}
                </Text>
                <Feather name="arrow-right" size={18} color={theme.colors.btnFg} />
              </Pressable>
            </View>
          )}
        </ScrollView>

        <View style={styles.inputBar}>
          <TextInput
            style={styles.textInput}
            value={input}
            onChangeText={setInput}
            placeholder="Describe what you want to do…"
            placeholderTextColor={theme.colors.faint}
            editable={!thinking}
            multiline
            onSubmitEditing={() => void send(input)}
            returnKeyType="send"
          />
          <Pressable
            style={[
              styles.sendButton,
              (!input.trim() || thinking) && styles.sendButtonDisabled,
            ]}
            onPress={() => void send(input)}
            disabled={!input.trim() || thinking}
          >
            <Feather name="arrow-up" size={20} color={theme.colors.accentFg} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colors.bg },
  startOver: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-end",
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1),
  },
  startOverText: { color: theme.colors.muted, fontSize: 13 },
  scrollContent: {
    padding: theme.spacing(2.5),
    gap: theme.spacing(1.5),
    flexGrow: 1,
  },

  hero: { paddingTop: theme.spacing(4), gap: theme.spacing(2) },
  heroTitle: {
    color: theme.colors.text,
    fontFamily: theme.serif,
    fontSize: 46,
    lineHeight: 48,
  },
  heroSub: {
    color: theme.colors.muted,
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 320,
  },
  pills: { gap: theme.spacing(1.25), marginTop: theme.spacing(1) },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing(1),
    paddingVertical: theme.spacing(1.75),
    paddingHorizontal: theme.spacing(2),
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  pillPressed: { backgroundColor: theme.colors.bgSoft },
  pillText: { color: theme.colors.text, fontSize: 15, fontWeight: "500", flex: 1 },

  bubble: {
    maxWidth: "86%",
    paddingVertical: theme.spacing(1.5),
    paddingHorizontal: theme.spacing(2),
    borderRadius: theme.radius.cardLg,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: theme.colors.accent,
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderBottomLeftRadius: 6,
  },
  userText: { color: theme.colors.accentFg, fontSize: 15, lineHeight: 22 },
  assistantText: { color: theme.colors.text, fontSize: 15, lineHeight: 22 },

  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing(1),
    paddingVertical: theme.spacing(1),
  },
  thinkingText: { color: theme.colors.muted, fontSize: 13 },

  errorCard: {
    padding: theme.spacing(1.75),
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.errSoft,
    borderWidth: 1,
    borderColor: theme.colors.err,
  },
  errorText: { color: theme.colors.err, fontSize: 13, lineHeight: 18 },

  handoffCard: {
    padding: theme.spacing(2.25),
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.accentLine,
    backgroundColor: theme.colors.surface,
    gap: theme.spacing(1.75),
    ...theme.shadow,
  },
  planList: { gap: theme.spacing(1) },
  planRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing(1.25) },
  planNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.accentSoft,
    color: theme.colors.accent,
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 22,
    overflow: "hidden",
  },
  planStep: { color: theme.colors.textSoft, fontSize: 14, flex: 1, lineHeight: 20 },
  ctaButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing(1),
    backgroundColor: theme.colors.btnBg,
    borderRadius: theme.radius.input,
    minHeight: 52,
  },
  ctaText: { color: theme.colors.btnFg, fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.85 },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing(1),
    paddingHorizontal: theme.spacing(2),
    paddingTop: theme.spacing(1.25),
    paddingBottom: theme.spacing(1.25),
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
  },
  textInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 16,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: theme.spacing(1.75),
    paddingVertical: theme.spacing(1.25),
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: { opacity: 0.4 },
  contact: { color: theme.colors.muted, fontSize: 13, lineHeight: 19, marginTop: theme.spacing(2) },
  contactLink: { color: theme.colors.text, fontWeight: "600" },
});
