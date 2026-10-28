import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  type ViewProps,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { isAddress } from "viem";
import { useAccount } from "wagmi";
import {
  ACTIVE_CHAINS,
  getChain,
  type ChainId,
} from "@railglide/shared/network";
import { useSession } from "@/store/session";
import { useWalletAuth } from "@/wallet/useWalletAuth";
import { usePaycrestOnramp } from "@/wallet/usePaycrestOnramp";
import { getInstitutions, getRate, verifyAccount } from "@/api/paycrest";
import {
  buildPaycrestReference,
  PAYCREST_CHAIN_IDS,
  PAYCREST_FIAT,
  type PaycrestFiat,
  type PaycrestInstitution,
  type PaycrestToken,
} from "@/rails/paycrest";
import {
  CHAINRAILS_RAMP_DESTINATIONS,
  type RampDestination,
} from "@/rails/chainrails";
import { ChainrailsBuyFlow } from "./ChainrailsBuyFlow";
import {
  checkBuyerDetails,
  trimBuyerDetails,
  type BuyerDetails,
} from "@railglide/shared/kyc";
import { BuyerDetailsFields } from "@/components/BuyerDetailsFields";
import {
  clearBuyerDetails,
  loadBuyerDetails,
  saveBuyerDetails,
} from "@/store/buyerDetails";
import { ApiError } from "@/api/client";
import {
  Field,
  Intro,
  PageTitle,
  Primary,
  Row,
  Secondary,
  formStyles as f,
} from "@/components/form";
import { Picker } from "@/components/Picker";
import { ChainLogo, RampLogo } from "@/components/Logo";
import { Confetti } from "@/components/Confetti";
import { SuccessCheck } from "@/components/SuccessCheck";
import {
  clearComposeDraft,
  loadComposeDraft,
  saveComposeDraft,
} from "@/lib/composeDraft";
import { copyToClipboard } from "@/lib/clipboard";
import { fiatSymbol, formatFiat } from "@/lib/format";
import { PrefixedAmountInput } from "@/components/PrefixedAmountInput";
import {
  chainOptions,
  currencyOptions,
  institutionOptions,
  tokenOptions,
} from "@/components/options";
import { theme } from "@/theme";
import { useTokenSupport } from "@/lib/useTokenSupport";

const TOKENS: PaycrestToken[] = ["USDC", "USDT"];

function buyChains(): ChainId[] {
  return PAYCREST_CHAIN_IDS.filter((id) =>
    ACTIVE_CHAINS.some((c) => c.id === id)
  );
}

type Step = "compose" | "recipient" | "review";

export function BuyScreen() {
  const launch = useSession((s) => s.pendingLaunch);
  const setPendingLaunch = useSession((s) => s.setPendingLaunch);
  const resumeOrder = useSession((s) => s.resumeOrder);
  const setResumeOrder = useSession((s) => s.setResumeOrder);
  const { address, isConnected } = useAccount();
  const { connect } = useWalletAuth();
  const onramp = usePaycrestOnramp();

  const chains = useMemo(buyChains, []);
  const [step, setStep] = useState<Step>("compose");
  // Non-Paycrest destination → ChainRails Buy flow. Null on a Paycrest chain.
  const [crDest, setCrDest] = useState<RampDestination | null>(null);
  const [crResumeId, setCrResumeId] = useState<string | null>(null);

  const [amount, setAmount] = useState(launch?.amount ?? "");
  const [token, setToken] = useState<PaycrestToken>("USDC");
  const [chain, setChain] = useState<ChainId>(chains[0]);
  const [currency, setCurrency] = useState<PaycrestFiat>(
    (launch?.currency as PaycrestFiat) &&
      PAYCREST_FIAT.includes(launch!.currency as PaycrestFiat)
      ? (launch!.currency as PaycrestFiat)
      : "NGN"
  );
  const [rate, setRate] = useState<number | null>(null);

  // Only chains where the token is actually supported (live list, with a
  // built-in fallback). ChainRails only delivers USDC, so its chains need USDC
  // there — Tron has none, so it never shows.
  const tokens = useTokenSupport();
  const tokenChains = chains.filter((id) => tokens.paycrest(id, token));
  // Switching token: move off a chain that doesn't carry it.
  const firstTokenChain = tokenChains[0];
  const chainOk = tokenChains.includes(chain);
  useEffect(() => {
    if (!chainOk && firstTokenChain) setChain(firstTokenChain);
  }, [chainOk, firstTokenChain]);

  // Paycrest chains (with logos) first, then the ChainRails-only chains — one
  // flat list; a `cr:` value routes to the ChainRails flow.
  const chainPickerOptions = useMemo(
    () => [
      ...chainOptions(tokenChains),
      ...(token === "USDC"
        ? CHAINRAILS_RAMP_DESTINATIONS.filter((d) =>
            tokens.chainrails(d.chainrailsChain, "USDC")
          ).map((d) => ({
            value: `cr:${d.chainrailsChain}`,
            label: d.label,
            icon: (
              <RampLogo
                chainrailsChain={d.chainrailsChain}
                label={d.label}
                size={24}
              />
            ),
          }))
        : []),
    ],
    [tokenChains, token, tokens]
  );

  // Receiving wallet — defaults to the connected wallet, but the user can paste
  // any address to receive the crypto elsewhere.
  const [recipient, setRecipient] = useState("");
  const recipientValid = isAddress(recipient);

  const [institutions, setInstitutions] = useState<PaycrestInstitution[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [institution, setInstitution] = useState<PaycrestInstitution | null>(
    null
  );
  const [account, setAccount] = useState("");
  const [accountName, setAccountName] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  // Date of birth + NIN (or ID) — Paycrest needs them on every Buy order.
  // Prefilled from the copy saved on this device.
  const [buyer, setBuyer] = useState<BuyerDetails>({ birthDate: "" });
  // On by default; turning it off forgets any copy saved on the device.
  const [rememberBuyer, setRememberBuyer] = useState(true);
  const [buyerSaved, setBuyerSaved] = useState(false);
  useEffect(() => {
    void loadBuyerDetails().then((saved) => {
      if (!saved) return;
      setBuyer(saved);
      setBuyerSaved(true);
    });
  }, []);
  const buyerProblems = checkBuyerDetails(currency, buyer);

  useEffect(() => () => setPendingLaunch(null), [setPendingLaunch]);

  // Restore a half-filled Buy form (from a prior visit / app restart) so nothing
  // has to be retyped. A chat launch wins, so we only restore without one.
  // `hydrated` gates the save effect so it can't overwrite the draft with the
  // blank initial state before the restore lands.
  const hydrated = useRef(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!launch) {
        const d = await loadComposeDraft("buy");
        if (active && d) {
          if (d.amount) setAmount(d.amount);
          if (d.currency && PAYCREST_FIAT.includes(d.currency as PaycrestFiat))
            setCurrency(d.currency as PaycrestFiat);
          if (d.token === "USDC" || d.token === "USDT") setToken(d.token);
          if (d.crChain) {
            const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
              (x) => x.chainrailsChain === d.crChain
            );
            if (dest) setCrDest(dest);
          } else if (d.chain && chains.includes(d.chain as ChainId)) {
            setChain(d.chain as ChainId);
          }
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
    void saveComposeDraft("buy", {
      amount,
      currency,
      token,
      chain,
      crChain: crDest?.chainrailsChain,
    });
  }, [amount, currency, token, chain, crDest]);

  // Resume a Buy order tapped in History.
  useEffect(() => {
    if (!resumeOrder) return;
    // ChainRails ramp order → open the ChainRails flow at its status screen.
    if (resumeOrder.chainrailsChain) {
      const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
        (d) => d.chainrailsChain === resumeOrder.chainrailsChain
      );
      if (dest) {
        setCrDest(dest);
        setCrResumeId(resumeOrder.id);
      }
      setResumeOrder(null);
      return;
    }
    if (resumeOrder.direction === "onramp") {
      void onramp.resume(resumeOrder.id);
      setResumeOrder(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeOrder]);

  // Prefill the receiving wallet with the connected address once, without
  // clobbering an address the user has since typed.
  useEffect(() => {
    if (address && !recipient) setRecipient(address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    getRate(currency, token, "buy")
      .then((r) => !cancelled && setRate(r.rate))
      .catch(() => !cancelled && setRate(null));
    return () => {
      cancelled = true;
    };
  }, [currency, token]);

  useEffect(() => {
    let cancelled = false;
    setInstitutions([]);
    setProvidersError(null);
    getInstitutions(currency)
      .then((list) => !cancelled && setInstitutions(list))
      .catch((err) => {
        if (cancelled) return;
        setInstitutions([]);
        setProvidersError(
          err instanceof ApiError
            ? err.message
            : "Couldn't load providers — check that the app can reach the backend."
        );
      });
    return () => {
      cancelled = true;
    };
  }, [currency]);

  // Fiat in → crypto out: divide the fiat amount by the unit rate.
  const estimate =
    rate && Number(amount) > 0
      ? (Number(amount) / rate).toLocaleString("en-US", {
          maximumFractionDigits: 2,
        })
      : null;

  const doVerify = async () => {
    if (!institution || !account.trim()) return;
    setVerifying(true);
    setRecipientError(null);
    setAccountName(null);
    try {
      setAccountName(await verifyAccount(institution.code, account.trim()));
    } catch (err) {
      setRecipientError(
        err instanceof ApiError ? err.message : "Couldn't verify that account."
      );
    } finally {
      setVerifying(false);
    }
  };

  const createOrder = async () => {
    if (!institution || !accountName || !recipientValid) return;
    if (buyerProblems.length > 0) return;
    const buyerToSend = trimBuyerDetails(currency, buyer);
    if (rememberBuyer) void saveBuyerDetails(buyerToSend);
    try {
      await onramp.onramp({
        toChain: chain,
        token,
        amount: amount.trim(),
        fiatCurrency: currency,
        refundAccount: {
          institution: institution.code,
          accountIdentifier: account.trim(),
          accountName,
        },
        buyer: buyerToSend,
        recipientAddress: recipient as `0x${string}`,
        reference: buildPaycrestReference("onramp", recipient),
      });
      // Order placed — drop the saved draft so a fresh buy starts clean.
      void clearComposeDraft("buy");
    } catch {
      // surfaced via onramp.error
    }
  };

  // Full reset back to a blank compose form — used by "New order" so it never
  // lands on the previous order's review/settling state.
  const newOrder = () => {
    onramp.reset();
    setStep("compose");
    setAmount("");
    setAccount("");
    setAccountName(null);
    setInstitution(null);
    setRecipientError(null);
  };

  if (crDest) {
    return (
      <ChainrailsBuyFlow
        destination={crDest}
        resumeOrderId={crResumeId ?? undefined}
        onBack={() => {
          setCrDest(null);
          setCrResumeId(null);
        }}
      />
    );
  }

  if (onramp.status !== "idle") {
    return (
      <OnrampStatus
        onramp={onramp}
        token={token}
        chain={chain}
        recipient={recipient}
        onNewOrder={newOrder}
      />
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {step !== "review" && (
        <>
          <PageTitle>Buy</PageTitle>
          <Intro>{`Pay with local currency, receive ${token} in your wallet.`}</Intro>
        </>
      )}

      {step === "compose" && (
        <>
          <Field label={`Amount (${currency})`}>
            <PrefixedAmountInput
              amount={amount}
              onChange={setAmount}
              prefix={fiatSymbol(currency)}
            />
          </Field>
          <Field label="Pay with">
            <Picker
              title="Pay with"
              value={currency}
              options={currencyOptions(PAYCREST_FIAT)}
              onChange={(c) => setCurrency(c as PaycrestFiat)}
            />
          </Field>
          <Field label="Receive token">
            <Picker
              title="Receive token"
              value={token}
              options={tokenOptions(TOKENS)}
              onChange={(t) => setToken(t as PaycrestToken)}
            />
          </Field>
          <Field label="On chain">
            <Picker
              title="Receive on"
              searchable
              value={chain}
              options={chainPickerOptions}
              onChange={(v) => {
                if (v.startsWith("cr:")) {
                  const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
                    (d) => `cr:${d.chainrailsChain}` === v
                  );
                  if (dest) setCrDest(dest);
                  return;
                }
                setChain(v as ChainId);
              }}
            />
          </Field>
          <Text style={f.estimate}>
            {estimate
              ? `≈ ${estimate} ${token}  (rate locks when you create the order)`
              : "Enter an amount to see the estimate"}
          </Text>
          <Primary
            label="Continue"
            disabled={!(Number(amount) > 0)}
            onPress={() => setStep("recipient")}
          />
        </>
      )}

      {step === "recipient" && (
        <>
          <Text style={f.estimate}>
            Your {token} lands in the receiving wallet below. A refund account
            is required in case the order can&apos;t be filled.
          </Text>

          {!isConnected ? (
            <Primary label="Connect wallet" onPress={connect} />
          ) : (
            <Field label="Receiving wallet">
              <TextInput
                style={[
                  f.input,
                  recipient.length > 0 && !recipientValid && styles.inputError,
                ]}
                value={recipient}
                onChangeText={setRecipient}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="0x…"
                placeholderTextColor={theme.colors.muted}
              />
              {address && recipient.toLowerCase() !== address.toLowerCase() && (
                <Pressable onPress={() => setRecipient(address)}>
                  <Text style={styles.useConnected}>Use connected wallet</Text>
                </Pressable>
              )}
              {recipient.length > 0 && !recipientValid && (
                <Text style={f.error}>Enter a valid wallet address.</Text>
              )}
            </Field>
          )}

          <Field label="Refund account — bank / mobile money">
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
          {providersError && <Text style={f.error}>{providersError}</Text>}

          {institution && (
            <>
              <Field label="Account number">
                <TextInput
                  style={f.input}
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
              {recipientError && <Text style={f.error}>{recipientError}</Text>}
            </>
          )}

          {accountName && (
            <BuyerDetailsFields
              currency={currency}
              value={buyer}
              onChange={setBuyer}
              remember={rememberBuyer}
              onRememberChange={(on) => {
                setRememberBuyer(on);
                if (!on) {
                  void clearBuyerDetails();
                  setBuyerSaved(false);
                }
              }}
              saved={buyerSaved}
            />
          )}
          {accountName && buyerProblems.length > 0 && (
            <Text style={f.estimate}>{buyerProblems[0]}</Text>
          )}

          <View style={f.rowButtons}>
            <Secondary label="Back" onPress={() => setStep("compose")} />
            <Primary
              label="Review"
              disabled={
                !accountName ||
                !isConnected ||
                !recipientValid ||
                buyerProblems.length > 0
              }
              onPress={() => setStep("review")}
            />
          </View>
        </>
      )}

      {step === "review" && (
        <>
          <View style={styles.reviewHeader}>
            <Text style={styles.reviewTitle}>Buy {token}</Text>
            <Text style={styles.reviewSubtitle}>
              Pay with {currency}, receive {token} in your wallet
            </Text>
          </View>

          <View style={styles.reviewCard}>
            <ReviewRow
              label="You pay"
              value={amount ? formatFiat(currency, amount) : `— ${currency}`}
            />
            <ReviewRow
              label="You receive"
              value={estimate ? `≈ ${estimate} ${token}` : `— ${token}`}
              accentLabel
            />
            <ReviewRow
              label="On"
              value={getChain(chain)?.name ?? chain}
              icon={<ChainLogo id={chain} size={18} />}
            />
            <CopyableShort
              label="Wallet"
              value={recipient}
              display={
                recipient
                  ? `${recipient.slice(0, 6)}…${recipient.slice(-4)}`
                  : ""
              }
            />
            <ReviewRow label="Refund to" value={accountName ?? ""} />
          </View>

          <Text style={styles.lockNote}>
            <Text style={styles.lockNoteStrong}>Final rate</Text> locks when you
            create the order.
          </Text>

          <Primary label="Create order" onPress={() => void createOrder()} />
          {onramp.error && <Text style={f.error}>{onramp.error}</Text>}
          <Secondary label="Back" onPress={() => setStep("recipient")} />
        </>
      )}
    </ScrollView>
  );
}

/** Review-card row: muted label (coral when highlighted) + bold right value,
 *  with an optional leading logo — matches the airier confirm-screen layout. */
function ReviewRow({
  label,
  value,
  accentLabel,
  icon,
}: {
  label: string;
  value: string;
  accentLabel?: boolean;
  icon?: ViewProps["children"];
}) {
  return (
    <View style={styles.reviewRow}>
      <Text
        style={[
          styles.reviewRowLabel,
          accentLabel && styles.reviewRowLabelAccent,
        ]}
      >
        {label}
      </Text>
      <View style={styles.reviewRowRight}>
        {icon}
        <Text style={styles.reviewRowValue}>{value}</Text>
      </View>
    </View>
  );
}

/** Truncated value that matches Row layout; tap copies the full `value`. */
function CopyableShort({
  label,
  value,
  display,
}: {
  label: string;
  value: string;
  display: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <Row l={label} r="" />;
  const copy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <Pressable
      style={({ pressed }) => [
        styles.copyableShort,
        pressed && styles.copyRowPressed,
      ]}
      onPress={() => void copy()}
      accessibilityRole="button"
      accessibilityHint="Copies the full wallet address"
    >
      <Text style={styles.copyableShortLabel}>{label}</Text>
      <View style={styles.copyableShortRight}>
        <Text style={styles.copyableShortValue}>
          {copied ? "Copied" : display}
        </Text>
        <Feather
          name={copied ? "check" : "copy"}
          size={14}
          color={copied ? theme.colors.ok : theme.colors.muted}
        />
      </View>
    </Pressable>
  );
}

// One tappable field that copies its value to the clipboard. If the native
// clipboard module isn't in this build, it stays a plain (non-copy) row.
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <Pressable
      style={({ pressed }) => [
        styles.copyRow,
        pressed && styles.copyRowPressed,
      ]}
      onPress={() => void copy()}
    >
      <View style={styles.copyMain}>
        <Text style={styles.copyLabel}>{label}</Text>
        <Text style={styles.copyValue} selectable>
          {value}
        </Text>
      </View>
      <Feather
        name={copied ? "check" : "copy"}
        size={16}
        color={copied ? theme.colors.ok : theme.colors.muted}
      />
    </Pressable>
  );
}

function OnrampStatus({
  onramp,
  token,
  chain,
  recipient,
  onNewOrder,
}: {
  onramp: ReturnType<typeof usePaycrestOnramp>;
  token: PaycrestToken;
  chain: ChainId;
  recipient: string;
  onNewOrder: () => void;
}) {
  const { status, order, error, depositSent, markSent } = onramp;

  // --- Success: the hero moment, with delivery details --------------------
  if (status === "complete") {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        <View style={styles.successCard}>
          <Confetti />
          <SuccessCheck />
          <Text style={styles.successEyebrow}>Transfer complete</Text>
          <Text style={styles.successAmount}>
            {order?.amount ?? ""} {token}
          </Text>
          <View style={styles.receivedBox}>
            <Text style={styles.receivedLabel}>RECEIVED AT</Text>
            <Text style={styles.receivedAddr} selectable>
              {recipient}
            </Text>
            <Text style={styles.receivedSub}>
              {token} on {getChain(chain)?.name ?? chain}
            </Text>
          </View>
          {order?.txHash && (
            <Text style={styles.txHash}>
              Tx {order.txHash.slice(0, 10)}…{order.txHash.slice(-8)}
            </Text>
          )}
        </View>
        <Primary label="New order" onPress={onNewOrder} />
      </ScrollView>
    );
  }

  // --- Awaiting deposit: details first, then confirm ----------------------
  if (status === "awaiting_deposit" && order) {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
      >
        <Text style={f.title}>Send your payment</Text>
        <Text style={f.estimate}>
          Transfer exactly this amount to the account below — tap any field to
          copy it. Your {token} arrives once we confirm the payment.
        </Text>
        <View style={styles.copyCard}>
          <CopyRow
            label="Amount"
            value={
              order.depositCurrency
                ? formatFiat(
                    order.depositCurrency,
                    order.amountToTransfer ?? ""
                  )
                : String(order.amountToTransfer ?? "")
            }
          />
          <CopyRow
            label="Account number"
            value={order.depositAccountIdentifier ?? ""}
          />
          {order.depositAccountName && (
            <CopyRow label="Account name" value={order.depositAccountName} />
          )}
          {order.depositInstitution && (
            <CopyRow label="Bank / provider" value={order.depositInstitution} />
          )}
        </View>

        {depositSent ? (
          <>
            <ActivityIndicator color={theme.colors.accent} style={styles.pad} />
            <Text style={f.estimate}>
              Confirming your payment — this can take a few minutes.
            </Text>
          </>
        ) : (
          <>
            <Primary label="I've sent the payment" onPress={markSent} />
            <Text style={f.estimate}>
              We&apos;ll only start checking once you&apos;ve paid — no need to
              keep this screen open the whole time.
            </Text>
          </>
        )}
        {error && <Text style={f.error}>{error}</Text>}
      </ScrollView>
    );
  }

  // --- Creating: centered spinner while the order is being placed ----------
  if (status === "creating") {
    return (
      <View style={styles.centeredPhase}>
        <View style={styles.phaseIconRing}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
        </View>
        <Text style={styles.phaseTitle}>Creating order</Text>
        <Text style={styles.phaseSub}>
          Locking your rate and setting up payment details…
        </Text>
      </View>
    );
  }

  // --- Settling ------------------------------------------------------------
  if (status === "settling") {
    return (
      <View style={styles.centeredPhase}>
        <View style={styles.phaseIconRing}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
        </View>
        <Text style={styles.phaseTitle}>Delivering your {token}</Text>
        <Text style={styles.phaseSub}>
          Payment confirmed — sending {token} to your wallet.
        </Text>
      </View>
    );
  }

  // --- Error ---------------------------------------------------------------
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
        <Primary label="Try again" onPress={onNewOrder} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: theme.spacing(2), gap: theme.spacing(1.5) },
  accountName: { color: theme.colors.ok, fontSize: 15, fontWeight: "600" },
  inputError: { borderColor: theme.colors.err },
  useConnected: {
    color: theme.colors.accent,
    fontSize: 13,
    fontWeight: "600",
    marginTop: theme.spacing(0.75),
  },
  pad: { paddingVertical: theme.spacing(2) },

  // Centered creating / settling / error phases
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

  // Confirm screen — centered header over the summary card
  reviewHeader: {
    alignItems: "center",
    gap: theme.spacing(0.5),
    marginBottom: theme.spacing(0.5),
  },
  reviewTitle: {
    color: theme.colors.text,
    fontFamily: theme.serif,
    fontSize: 38,
    lineHeight: 42,
    textAlign: "center",
  },
  reviewSubtitle: {
    color: theme.colors.muted,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  reviewCard: {
    padding: theme.spacing(2.5),
    borderRadius: theme.radius.cardLg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing(1.75),
    ...theme.shadow,
  },
  reviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing(2),
  },
  reviewRowLabel: { color: theme.colors.muted, fontSize: 15 },
  reviewRowLabelAccent: { color: theme.colors.accent, fontWeight: "600" },
  reviewRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  reviewRowValue: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },
  lockNote: {
    color: theme.colors.muted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: theme.spacing(0.25),
  },
  lockNoteStrong: { color: theme.colors.textSoft, fontWeight: "600" },

  // Truncated row that copies the full value on tap (same footprint as Row)
  copyableShort: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing(2),
    borderRadius: 6,
    marginHorizontal: -4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  copyableShortLabel: { color: theme.colors.muted, fontSize: 15 },
  copyableShortRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  copyableShortValue: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },

  // Copyable deposit fields
  copyCard: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  copyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1.75),
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  copyRowPressed: { backgroundColor: theme.colors.bgSoft },
  copyMain: { flex: 1, gap: 3, marginRight: theme.spacing(1.5) },
  copyLabel: {
    color: theme.colors.muted,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  copyValue: { color: theme.colors.text, fontSize: 17, fontWeight: "600" },

  // Success card
  successCard: {
    position: "relative",
    overflow: "hidden",
    alignItems: "center",
    borderRadius: theme.radius.cardLg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing(3),
    paddingTop: theme.spacing(3.5),
    paddingBottom: theme.spacing(3),
    gap: theme.spacing(0.75),
    ...theme.shadow,
  },
  successEyebrow: {
    color: theme.colors.ok,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: theme.spacing(1.5),
  },
  successAmount: {
    color: theme.colors.text,
    fontFamily: theme.serif,
    fontSize: 40,
    lineHeight: 46,
  },
  receivedBox: {
    alignSelf: "stretch",
    marginTop: theme.spacing(1.5),
    borderRadius: theme.radius.input,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
    padding: theme.spacing(1.75),
    gap: 4,
  },
  receivedLabel: {
    color: theme.colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  receivedAddr: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
  receivedSub: { color: theme.colors.muted, fontSize: 12 },
  txHash: {
    color: theme.colors.muted,
    fontSize: 12,
    marginTop: theme.spacing(0.5),
  },
});
