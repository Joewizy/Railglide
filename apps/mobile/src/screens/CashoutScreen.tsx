import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  type ViewProps,
} from "react-native";
import { useAccount, useBalance } from "wagmi";
import {
  ACTIVE_CHAINS,
  getChain,
  getTokenAddress,
  resolveChain,
  type ChainId,
} from "@railglide/shared/network";
import { useSession } from "@/store/session";
import { useWalletAuth } from "@/wallet/useWalletAuth";
import { usePaycrestOfframp } from "@/wallet/usePaycrestOfframp";
import { getInstitutions, getRate, verifyAccount } from "@/api/paycrest";
import {
  buildPaycrestReference,
  PAYCREST_CHAIN_IDS,
  PAYCREST_FIAT,
  type PaycrestFiat,
  type PaycrestInstitution,
  type PaycrestToken,
} from "@/rails/paycrest";
import { ApiError } from "@/api/client";
import { Intro, PageTitle } from "@/components/form";
import { copyToClipboard } from "@/lib/clipboard";
import { formatFiat } from "@/lib/format";
import { PrefixedAmountInput } from "@/components/PrefixedAmountInput";
import { Feather } from "@expo/vector-icons";
import { Picker } from "@/components/Picker";
import {
  chainOptions,
  currencyOptions,
  institutionOptions,
  tokenOptions,
} from "@/components/options";
import { TokenLogo, ChainLogo } from "@/components/Logo";
import { Confetti } from "@/components/Confetti";
import { SuccessCheck } from "@/components/SuccessCheck";
import {
  clearComposeDraft,
  loadComposeDraft,
  saveComposeDraft,
} from "@/lib/composeDraft";
import { theme } from "@/theme";
import { useTokenSupport } from "@/lib/useTokenSupport";

const TOKENS: PaycrestToken[] = ["USDC", "USDT"];

/** Chains that are both in the active network universe and Paycrest-supported. */
function offrampChains(): ChainId[] {
  return PAYCREST_CHAIN_IDS.filter((id) =>
    ACTIVE_CHAINS.some((c) => c.id === id)
  );
}

type Step = "compose" | "recipient" | "review";

export function CashoutScreen() {
  const launch = useSession((s) => s.pendingLaunch);
  const setPendingLaunch = useSession((s) => s.setPendingLaunch);
  const resumeOrder = useSession((s) => s.resumeOrder);
  const setResumeOrder = useSession((s) => s.setResumeOrder);
  const { address, isConnected } = useAccount();
  const { connect } = useWalletAuth();
  const offramp = usePaycrestOfframp();

  const chains = useMemo(offrampChains, []);
  const [step, setStep] = useState<Step>("compose");

  // Compose
  const [amount, setAmount] = useState(launch?.amount ?? "");
  const [token, setToken] = useState<PaycrestToken>(
    (launch?.token as PaycrestToken) === "USDT" ? "USDT" : "USDC"
  );
  const [chain, setChain] = useState<ChainId>(
    (launch?.chain && resolveChain(launch.chain)) || chains[0]
  );
  const [currency, setCurrency] = useState<PaycrestFiat>(
    (launch?.currency as PaycrestFiat) &&
      PAYCREST_FIAT.includes(launch!.currency as PaycrestFiat)
      ? (launch!.currency as PaycrestFiat)
      : "NGN"
  );
  const [rate, setRate] = useState<number | null>(null);

  // Recipient
  const [institutions, setInstitutions] = useState<PaycrestInstitution[]>([]);
  const [institution, setInstitution] = useState<PaycrestInstitution | null>(
    null
  );
  const [account, setAccount] = useState("");
  const [accountName, setAccountName] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  // Clear the one-shot handoff so leaving and returning starts fresh.
  useEffect(() => {
    return () => setPendingLaunch(null);
  }, [setPendingLaunch]);

  // Restore a half-filled Sell form (from a prior visit / app restart) so
  // nothing has to be retyped. A chat launch wins, so we only restore without
  // one. `hydrated` gates the save effect so it can't clobber the draft with the
  // blank initial state before the restore lands.
  const hydrated = useRef(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!launch) {
        const d = await loadComposeDraft("cashout");
        if (active && d) {
          if (d.amount) setAmount(d.amount);
          if (d.currency && PAYCREST_FIAT.includes(d.currency as PaycrestFiat))
            setCurrency(d.currency as PaycrestFiat);
          if (d.token === "USDC" || d.token === "USDT") setToken(d.token);
          if (d.chain && chains.includes(d.chain as ChainId))
            setChain(d.chain as ChainId);
        }
      }
      hydrated.current = true;
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    void saveComposeDraft("cashout", { amount, currency, token, chain });
  }, [amount, currency, token, chain]);

  // Resume a sell order tapped in History.
  useEffect(() => {
    if (resumeOrder?.direction === "offramp") {
      void offramp.resume(resumeOrder.id, {
        token: resumeOrder.token === "USDT" ? "USDT" : "USDC",
        network: resumeOrder.network,
      });
      setResumeOrder(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeOrder]);

  // Live unit rate for the estimate.
  useEffect(() => {
    let cancelled = false;
    getRate(currency, token)
      .then((r) => !cancelled && setRate(r.rate))
      .catch(() => !cancelled && setRate(null));
    return () => {
      cancelled = true;
    };
  }, [currency, token]);

  // Institutions for the chosen currency.
  useEffect(() => {
    let cancelled = false;
    setInstitutions([]);
    getInstitutions(currency)
      .then((list) => !cancelled && setInstitutions(list))
      .catch(() => !cancelled && setInstitutions([]));
    return () => {
      cancelled = true;
    };
  }, [currency]);

  const estimate =
    rate && Number(amount) > 0
      ? (Number(amount) * rate).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        })
      : null;

  // Connected wallet's balance of the selected token on the selected chain, so
  // the user can't try to sell more than they hold (the transfer would revert).
  // Only chains where Paycrest supports the token (live list, with a built-in
  // fallback) and we have its contract address to send from.
  const tokens = useTokenSupport();
  const tokenChains = chains.filter(
    (id) => !!getTokenAddress(token, id) && tokens.paycrest(id, token)
  );
  // Switching token: move off a chain that doesn't carry it.
  const firstTokenChain = tokenChains[0];
  const chainOk = tokenChains.includes(chain);
  useEffect(() => {
    if (!chainOk && firstTokenChain) setChain(firstTokenChain);
  }, [chainOk, firstTokenChain]);

  const tokenAddress = getTokenAddress(token, chain);
  const viemChainId = getChain(chain)?.viemChain?.id;
  const balanceQuery = useBalance({
    address,
    token: tokenAddress ? (tokenAddress as `0x${string}`) : undefined,
    chainId: viemChainId,
    query: {
      enabled: isConnected && !!tokenAddress && !!viemChainId,
    },
  });
  const balance = balanceQuery.data
    ? Number(balanceQuery.data.formatted)
    : null;
  const insufficient =
    balance != null && Number(amount) > 0 && Number(amount) > balance;

  const doVerify = async () => {
    if (!institution || !account.trim()) return;
    setVerifying(true);
    setRecipientError(null);
    setAccountName(null);
    try {
      const name = await verifyAccount(institution.code, account.trim());
      setAccountName(name);
    } catch (err) {
      setRecipientError(
        err instanceof ApiError ? err.message : "Couldn't verify that account."
      );
    } finally {
      setVerifying(false);
    }
  };

  const createOrder = async () => {
    if (!institution || !accountName || !address) return;
    try {
      await offramp.offramp({
        fromChain: chain,
        token,
        amount: amount.trim(),
        fiatCurrency: currency,
        recipient: {
          institution: institution.code,
          accountIdentifier: account.trim(),
          accountName,
        },
        refundAddress: address as `0x${string}`,
        reference: buildPaycrestReference("offramp", address),
      });
      // Order placed — drop the saved draft so a fresh sale starts clean.
      void clearComposeDraft("cashout");
    } catch {
      // error surfaced via offramp.error
    }
  };

  // ---- Order in flight: funding / settling / done ----------------------
  if (offramp.status !== "idle") {
    return (
      <OrderStatus
        offramp={offramp}
        token={token}
        currency={currency}
        chain={chain}
      />
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <PageTitle>Sell</PageTitle>
      <Intro>Sell stablecoins to a bank or mobile money account.</Intro>
      <Steps step={step} />

      {step === "compose" && (
        <>
          <Field label="Amount">
            <PrefixedAmountInput
              amount={amount}
              onChange={setAmount}
              prefix="$"
              error={insufficient}
            />
            {isConnected && (
              <View style={styles.balanceRow}>
                <Text style={insufficient ? styles.error : styles.balance}>
                  {balanceQuery.isLoading
                    ? "Checking balance…"
                    : balance != null
                      ? `Balance: ${balance.toLocaleString("en-US", {
                          maximumFractionDigits: 4,
                        })} ${token}`
                      : "Balance unavailable"}
                </Text>
                {balance != null && balance > 0 && (
                  <Pressable
                    onPress={() => setAmount(String(balance))}
                    hitSlop={8}
                  >
                    <Text style={styles.maxLink}>Max</Text>
                  </Pressable>
                )}
              </View>
            )}
          </Field>

          <Field label="Token">
            <Picker
              title="Token"
              value={token}
              options={tokenOptions(TOKENS)}
              onChange={(t) => setToken(t as PaycrestToken)}
            />
          </Field>

          <Field label="From chain">
            <Picker
              title="From chain"
              value={chain}
              options={chainOptions(tokenChains)}
              onChange={(c) => setChain(c as ChainId)}
            />
          </Field>

          <Field label="Payout currency">
            <Picker
              title="Payout currency"
              value={currency}
              options={currencyOptions(PAYCREST_FIAT)}
              onChange={(c) => setCurrency(c as PaycrestFiat)}
            />
          </Field>

          <Text style={styles.estimate}>
            {estimate
              ? `≈ ${formatFiat(currency, estimate)}  (rate locks when you create the order)`
              : "Enter an amount to see the estimate"}
          </Text>

          {insufficient && (
            <Text style={styles.error}>
              Not enough {token} on {getChain(chain)?.name ?? chain}. Add funds
              or lower the amount.
            </Text>
          )}

          <Primary
            label="Continue"
            disabled={!(Number(amount) > 0) || insufficient}
            onPress={() => setStep("recipient")}
          />
        </>
      )}

      {step === "recipient" && (
        <>
          <Field label="Bank / mobile money">
            <Picker
              title="Choose provider"
              searchable
              placeholder={
                institutions.length ? "Select provider" : "Loading providers…"
              }
              value={institution?.code}
              options={institutionOptions(institutions)}
              onChange={(code) => {
                setInstitution(
                  institutions.find((i) => i.code === code) ?? null
                );
                setAccountName(null);
              }}
            />
          </Field>

          {institution && (
            <>
              <Field label="Account number">
                <TextInput
                  style={styles.input}
                  value={account}
                  onChangeText={(t) => {
                    setAccount(t);
                    setAccountName(null);
                  }}
                  keyboardType="number-pad"
                  placeholder="Account / phone number"
                  placeholderTextColor={theme.colors.muted}
                />
              </Field>

              {accountName ? (
                <Text style={styles.accountName}>✓ {accountName}</Text>
              ) : (
                <Primary
                  label={verifying ? "Verifying…" : "Verify account"}
                  disabled={!account.trim() || verifying}
                  onPress={() => void doVerify()}
                />
              )}
              {recipientError && (
                <Text style={styles.error}>{recipientError}</Text>
              )}
            </>
          )}

          <View style={styles.rowButtons}>
            <Secondary label="Back" onPress={() => setStep("compose")} />
            <Primary
              label="Review"
              disabled={!accountName}
              onPress={() => setStep("review")}
            />
          </View>
        </>
      )}

      {step === "review" && (
        <>
          <View style={styles.card}>
            <Row l="You send" r={`${amount} ${token}`} />
            <Row l="On" r={getChain(chain)?.name ?? chain} />
            <Row
              l="Recipient gets"
              r={
                estimate
                  ? `≈ ${formatFiat(currency, estimate)}`
                  : `— ${currency}`
              }
            />
            <Row l="To" r={institution?.name ?? ""} />
            <Row l="Name" r={accountName ?? ""} />
            <Row l="Account" r={account} />
          </View>
          <Text style={styles.estimate}>
            Estimate · the final rate locks when you create the order.
          </Text>

          {!isConnected ? (
            <Primary label="Connect wallet" onPress={connect} />
          ) : (
            <Primary label="Create order" onPress={() => void createOrder()} />
          )}
          {offramp.error && <Text style={styles.error}>{offramp.error}</Text>}

          <Secondary label="Back" onPress={() => setStep("recipient")} />
        </>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Order status (funding → settling → complete / error)
// ---------------------------------------------------------------------------

function OrderStatus({
  offramp,
  token,
  currency,
  chain,
}: {
  offramp: ReturnType<typeof usePaycrestOfframp>;
  token: PaycrestToken;
  currency: PaycrestFiat;
  chain: ChainId;
}) {
  const {
    status,
    order,
    error,
    fund,
    reset,
    transferTxHash,
    manualCheck,
    markSent,
    fundable,
  } = offramp;
  const [copied, setCopied] = useState(false);
  const [orderCopied, setOrderCopied] = useState(false);
  const copyAddr = async () => {
    if (
      order?.receiveAddress &&
      (await copyToClipboard(order.receiveAddress))
    ) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  const copyOrderId = async () => {
    if (order && (await copyToClipboard(String(order.id)))) {
      setOrderCopied(true);
      setTimeout(() => setOrderCopied(false), 1400);
    }
  };

  // --- Success: the hero moment (mirrors the website's payout card) --------
  if (status === "complete") {
    const payout =
      order && Number(order.amount) > 0 && Number(order.rate) > 0
        ? formatFiat(currency, Number(order.amount) * Number(order.rate))
        : null;
    const networkName = getChain(chain)?.name ?? chain;
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        <View style={styles.hero}>
          <Confetti />
          <SuccessCheck />
          <Text style={styles.heroEyebrow}>Payout complete</Text>
          {payout && <Text style={styles.heroAmount}>{payout}</Text>}
          <Text style={styles.heroSub}>
            sent to the recipient&apos;s bank account
          </Text>
          <View style={styles.heroPill}>
            <TokenLogo symbol={token} size={17} />
            <Text style={styles.heroPillText}>
              {order?.amount} {token}
            </Text>
            <Text style={styles.heroPillMuted}>on</Text>
            <ChainLogo id={chain} size={16} />
            <Text style={styles.heroPillText}>{networkName}</Text>
          </View>
          <View style={styles.heroDivider} />
          <Pressable
            onPress={() => void copyOrderId()}
            style={styles.heroOrderRow}
            hitSlop={8}
          >
            <Text style={styles.heroOrderText}>Order #{order?.id}</Text>
            <Feather
              name={orderCopied ? "check" : "copy"}
              size={12}
              color={orderCopied ? theme.colors.ok : theme.colors.muted}
            />
          </Pressable>
        </View>
        <Primary label="Sell again" onPress={reset} />
      </ScrollView>
    );
  }

  if (status === "creating") {
    return (
      <View style={styles.centeredPhase}>
        <View style={styles.phaseIconRing}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
        </View>
        <Text style={styles.phaseTitle}>Creating order</Text>
        <Text style={styles.phaseSub}>
          Locking your rate and preparing the deposit…
        </Text>
      </View>
    );
  }

  if (status === "funding") {
    return (
      <View style={styles.centeredPhase}>
        <View style={styles.phaseIconRing}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
        </View>
        <Text style={styles.phaseTitle}>Sending {token}</Text>
        <Text style={styles.phaseSub}>
          Confirm the transfer in your wallet if prompted.
        </Text>
      </View>
    );
  }

  if (status === "settling") {
    return (
      <View style={styles.centeredPhase}>
        <View style={styles.phaseIconRing}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
        </View>
        <Text style={styles.phaseTitle}>Paying the recipient</Text>
        <Text style={styles.phaseSub}>
          Your {token} is confirmed — sending {currency} to their account.
        </Text>
      </View>
    );
  }

  if (status === "error" && !order) {
    return (
      <View style={styles.centeredPhase}>
        <View style={[styles.phaseIconRing, styles.phaseIconError]}>
          <Feather name="alert-circle" size={28} color={theme.colors.err} />
        </View>
        <Text style={styles.phaseTitle}>Something went wrong</Text>
        <Text style={styles.phaseError}>
          {error ?? "We couldn't create this order. Please try again."}
        </Text>
        <View style={styles.phaseActions}>
          <Primary label="Try again" onPress={reset} />
        </View>
      </View>
    );
  }

  const phase =
    status === "awaiting_funding"
      ? "Fund your order"
      : status === "error"
        ? "Something went wrong"
        : "Working…";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{phase}</Text>

      {order && (
        <View style={styles.card}>
          <Row l="Send exactly" r={`${order.amount} ${token}`} />
          {order.rate && (
            <Row l="Locked rate" r={`${order.rate} ${currency}`} />
          )}
          <Row l="Status" r={order.status} />
        </View>
      )}

      {order?.receiveAddress && (
        <View style={styles.addrBlock}>
          <Text style={styles.addrLabel}>
            Deposit address — send {token} here
          </Text>
          <Text style={styles.addrText} selectable>
            {order.receiveAddress}
          </Text>
          <Pressable onPress={() => void copyAddr()} hitSlop={8}>
            <Text style={styles.copyLink}>
              {copied ? "Copied ✓" : "Copy address"}
            </Text>
          </Pressable>
        </View>
      )}

      {status === "awaiting_funding" && (
        <>
          {fundable ? (
            <>
              <Text style={styles.estimate}>
                Send {order?.amount} {token} to the provider to complete the
                sale. Tap Send from wallet, or send to the deposit address above
                from another wallet (long-press it to copy).
              </Text>
              <Primary label="Send from wallet" onPress={() => void fund()} />
            </>
          ) : (
            <Text style={styles.estimate}>
              To finish this order, send {order?.amount} {token} to the deposit
              address above (long-press it to copy). Then tap the button below
              so we start checking.
            </Text>
          )}
          {manualCheck ? (
            <Text style={styles.estimate}>Checking for your transfer…</Text>
          ) : (
            <Secondary label="I've sent the payment" onPress={markSent} />
          )}
        </>
      )}

      {transferTxHash && (
        <Text style={styles.estimate}>
          Payment tx {transferTxHash.slice(0, 10)}…
        </Text>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {status === "error" && <Primary label="Sell again" onPress={reset} />}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function Steps({ step }: { step: Step }) {
  const order: Step[] = ["compose", "recipient", "review"];
  const labels = {
    compose: "Amount",
    recipient: "Recipient",
    review: "Review",
  };
  return (
    <View style={styles.steps}>
      {order.map((s) => (
        <Text
          key={s}
          style={[styles.stepChip, step === s && styles.stepChipActive]}
        >
          {labels[s]}
        </Text>
      ))}
    </View>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ViewProps["children"];
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Row({ l, r }: { l: string; r: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{l}</Text>
      <Text style={styles.rowValue} selectable>
        {r}
      </Text>
    </View>
  );
}

function Primary({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.primary, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function Secondary({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.secondary} onPress={onPress}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: theme.spacing(2.5), gap: theme.spacing(1.75) },
  title: { color: theme.colors.text, fontSize: 30, fontFamily: theme.serif },
  addrBlock: {
    padding: theme.spacing(2),
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing(0.75),
    ...theme.shadow,
  },
  addrLabel: {
    color: theme.colors.muted,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  addrText: {
    color: theme.colors.text,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600",
  },
  copyLink: {
    color: theme.colors.accent,
    fontSize: 13,
    fontWeight: "600",
    marginTop: theme.spacing(0.5),
  },
  steps: {
    flexDirection: "row",
    gap: theme.spacing(1),
    marginBottom: theme.spacing(1),
  },
  stepChip: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: "600",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  stepChipActive: {
    color: theme.colors.accentFg,
    backgroundColor: theme.colors.accent,
  },
  field: { gap: theme.spacing(0.75) },
  fieldLabel: { color: theme.colors.muted, fontSize: 13 },
  balanceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing(0.25),
  },
  balance: { color: theme.colors.muted, fontSize: 13 },
  maxLink: { color: theme.colors.accent, fontSize: 13, fontWeight: "700" },
  input: {
    color: theme.colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(1.25),
    backgroundColor: theme.colors.surface,
  },
  inputError: { borderColor: theme.colors.err },
  estimate: { color: theme.colors.muted, fontSize: 13, lineHeight: 19 },
  accountName: { color: theme.colors.ok, fontSize: 15, fontWeight: "600" },
  card: {
    padding: theme.spacing(2.25),
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing(1.25),
    ...theme.shadow,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing(2),
  },
  rowLabel: { color: theme.colors.muted, fontSize: 14 },
  rowValue: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },
  rowButtons: {
    flexDirection: "row",
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  },
  pad: { paddingVertical: theme.spacing(2) },

  // Completed-payout hero — elevated card, celebratory checkmark + confetti.
  hero: {
    position: "relative",
    overflow: "hidden",
    alignItems: "center",
    borderRadius: theme.radius.cardLg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing(3),
    paddingTop: theme.spacing(4),
    paddingBottom: theme.spacing(3),
    marginTop: theme.spacing(1),
    ...theme.shadow,
  },
  heroEyebrow: {
    color: theme.colors.ok,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: theme.spacing(2),
  },
  heroAmount: {
    color: theme.colors.text,
    fontFamily: theme.serif,
    fontSize: 46,
    lineHeight: 52,
    marginTop: theme.spacing(0.75),
  },
  heroSub: {
    color: theme.colors.textSoft,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    marginTop: theme.spacing(1),
    maxWidth: 280,
  },
  heroPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: theme.spacing(2),
    paddingHorizontal: theme.spacing(1.75),
    paddingVertical: theme.spacing(1),
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgSoft,
  },
  heroPillText: { color: theme.colors.textSoft, fontSize: 13, fontWeight: "600" },
  heroPillMuted: { color: theme.colors.muted, fontSize: 12 },
  heroDivider: {
    alignSelf: "stretch",
    height: 1,
    backgroundColor: theme.colors.border,
    marginTop: theme.spacing(2.25),
  },
  heroOrderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: theme.spacing(1.75),
  },
  heroOrderText: { color: theme.colors.muted, fontSize: 12 },

  centeredPhase: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing(3),
    gap: theme.spacing(1.25),
  },
  phaseIconRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing(1),
  },
  phaseIconError: {
    backgroundColor: "#FDF2F0",
    borderColor: "#F5C4BC",
  },
  phaseTitle: {
    color: theme.colors.text,
    fontFamily: theme.serif,
    fontSize: 28,
    lineHeight: 34,
    textAlign: "center",
  },
  phaseSub: {
    color: theme.colors.muted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    maxWidth: 280,
  },
  phaseError: {
    color: theme.colors.err,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    maxWidth: 300,
  },
  phaseActions: {
    alignSelf: "stretch",
    marginTop: theme.spacing(2),
  },

  primary: {
    backgroundColor: theme.colors.btnBg,
    borderRadius: theme.radius.input,
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
  },
  primaryText: {
    color: theme.colors.btnFg,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  disabled: { opacity: 0.4 },
  secondary: {
    borderRadius: 10,
    padding: theme.spacing(1.5),
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    flex: 1,
  },
  secondaryText: { color: theme.colors.text, fontSize: 15, fontWeight: "600" },
  error: { color: theme.colors.err, fontSize: 13 },
});
