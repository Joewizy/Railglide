// Buy (local currency → stablecoin), in the redesign's layout:
//   1. Amount — "You pay" in local currency, rate, "You receive" with token + chain
//   2. Review — where the USDC goes, refund account, your details
//   3. Pay — "Pay into this account", locked quote, progress, countdown
//      (or the calm expired page)
// Picking a ChainRails chain hands off to ChainrailsBuyFlow.
// Mirrors the website's BuyFlow → BuyReview → PaycrestOrderScreen.
import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { isAddress } from "viem";
import { useAccount } from "wagmi";
import { ACTIVE_CHAINS, getChain, type ChainId } from "@railglide/shared/network";
import { checkBuyerDetails, trimBuyerDetails, type BuyerDetails } from "@railglide/shared/kyc";
import { useSession } from "@/store/session";
import { usePaycrestOnramp } from "@/wallet/usePaycrestOnramp";
import { getRate } from "@/api/paycrest";
import {
  buildPaycrestReference,
  paycrestOnrampPaid,
  PAYCREST_CHAIN_IDS,
  PAYCREST_FIAT,
  type PaycrestFiat,
  type PaycrestToken,
} from "@/rails/paycrest";
import { CHAINRAILS_RAMP_DESTINATIONS, type RampDestination } from "@/rails/chainrails";
import { ChainrailsBuyFlow } from "./ChainrailsBuyFlow";
import { BuyerDetailsFields } from "@/components/BuyerDetailsFields";
import { clearBuyerDetails, loadBuyerDetails, saveBuyerDetails } from "@/store/buyerDetails";
import { ChainLogo, RampLogo, TokenLogo } from "@/components/Logo";
import { Confetti } from "@/components/Confetti";
import { SuccessCheck } from "@/components/SuccessCheck";
import { clearComposeDraft, loadComposeDraft, saveComposeDraft } from "@/lib/composeDraft";
import { FIAT_INFO, formatFiat, formatToken } from "@/lib/format";
import { useTokenSupport } from "@/lib/useTokenSupport";
import { CurrencySheet, TokenChainSheet, type CurrencyOption } from "@/components/flowPickers";
import {
  BankAccount,
  EMPTY_ACCOUNT,
  accountBlocker,
  type BankAccountValue,
  type LookupState,
} from "@/components/BankAccount";
import { ExpiredOrder } from "@/components/ExpiredOrder";
import {
  AmountCard,
  Card,
  CopyRow,
  CurrencyPill,
  DetailRows,
  FieldLabel,
  FlowHeader,
  FlowScreen,
  Notice,
  PrimaryButton,
  ProgressList,
  RateLine,
  SecondaryButton,
  StepProgress,
  TextField,
  TextLink,
  TokenChainPill,
  clockTime,
  kitStyles,
  short0x,
} from "@/components/kit";
import { theme, z, zf } from "@/theme";

const c = theme.flow;
const TOKENS: PaycrestToken[] = ["USDC", "USDT"];
const STEPS = ["Amount", "Review", "Pay"];

function buyChains(): ChainId[] {
  return PAYCREST_CHAIN_IDS.filter((id) => ACTIVE_CHAINS.some((ch) => ch.id === id));
}

const currencyOption = (code: string): CurrencyOption => ({
  value: code,
  code,
  flag: FIAT_INFO[code]?.flag ?? "🌍",
  country: FIAT_INFO[code]?.country ?? code,
  name: FIAT_INFO[code]?.name ?? code,
});

type Step = "amount" | "review";

export function BuyScreen() {
  const launch = useSession((s) => s.pendingLaunch);
  const setPendingLaunch = useSession((s) => s.setPendingLaunch);
  const resumeOrder = useSession((s) => s.resumeOrder);
  const setResumeOrder = useSession((s) => s.setResumeOrder);
  const { address } = useAccount();
  const onramp = usePaycrestOnramp();

  const chains = useMemo(buyChains, []);
  const [step, setStep] = useState<Step>("amount");
  // A ChainRails chain hands off to the ChainRails Buy flow.
  const [crDest, setCrDest] = useState<RampDestination | null>(null);
  const [crResumeId, setCrResumeId] = useState<string | null>(null);

  const [amount, setAmount] = useState(launch?.amount ?? "");
  const [token, setToken] = useState<PaycrestToken>("USDC");
  const [chain, setChain] = useState<ChainId>(chains[0]);
  const [currency, setCurrency] = useState<PaycrestFiat>(
    (launch?.currency as PaycrestFiat) && PAYCREST_FIAT.includes(launch!.currency as PaycrestFiat)
      ? (launch!.currency as PaycrestFiat)
      : "NGN"
  );
  const [rate, setRate] = useState<number | null>(null);
  const [chainOpen, setChainOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);

  // Review
  const [recipient, setRecipient] = useState("");
  const [refund, setRefund] = useState<BankAccountValue>(EMPTY_ACCOUNT);
  const [lookup, setLookup] = useState<LookupState>("idle");
  const [buyer, setBuyer] = useState<BuyerDetails>({ birthDate: "" });
  const [rememberBuyer, setRememberBuyer] = useState(true);
  const [buyerSaved, setBuyerSaved] = useState(false);

  useEffect(() => {
    void loadBuyerDetails().then((saved) => {
      if (!saved) return;
      setBuyer(saved);
      setBuyerSaved(true);
    });
  }, []);

  useEffect(() => () => setPendingLaunch(null), [setPendingLaunch]);

  // Restore a half-filled Buy form (prior visit / app restart). A chat launch
  // wins. `hydrated` stops the save effect clobbering the draft before restore.
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
            const dest = CHAINRAILS_RAMP_DESTINATIONS.find((x) => x.chainrailsChain === d.crChain);
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
    void saveComposeDraft("buy", { amount, currency, token, chain, crChain: crDest?.chainrailsChain });
  }, [amount, currency, token, chain, crDest]);

  // Resume a Buy order tapped in History.
  useEffect(() => {
    if (!resumeOrder) return;
    if (resumeOrder.chainrailsChain) {
      const dest = CHAINRAILS_RAMP_DESTINATIONS.find((d) => d.chainrailsChain === resumeOrder.chainrailsChain);
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

  // Prefill where the USDC goes with the connected wallet, without clobbering
  // an address the user has typed.
  useEffect(() => {
    if (address) setRecipient((cur) => cur || address);
  }, [address]);

  // Buy rate (higher than the sell rate) for the estimate.
  useEffect(() => {
    let cancelled = false;
    getRate(currency, token, "buy")
      .then((r) => !cancelled && setRate(r.rate))
      .catch(() => !cancelled && setRate(null));
    return () => {
      cancelled = true;
    };
  }, [currency, token]);

  // Only chains where the token is supported (live list, with a fallback).
  // ChainRails only delivers USDC, so its chains need USDC — Tron has none.
  const tokens = useTokenSupport();
  const tokenChains = chains.filter((id) => tokens.paycrest(id, token));
  const firstTokenChain = tokenChains[0];
  const chainOk = tokenChains.includes(chain);
  useEffect(() => {
    if (!chainOk && firstTokenChain) setChain(firstTokenChain);
  }, [chainOk, firstTokenChain]);

  const amountNum = Number(amount) || 0;
  const estimate = rate && amountNum > 0 ? amountNum / rate : null;
  const chainName = getChain(chain)?.name ?? chain;
  const recipientValid = isAddress(recipient.trim());
  const buyerProblems = checkBuyerDetails(currency, buyer);

  const createOrder = async () => {
    const buyerToSend = trimBuyerDetails(currency, buyer);
    if (rememberBuyer) void saveBuyerDetails(buyerToSend);
    try {
      await onramp.onramp({
        toChain: chain,
        token,
        amount: amount.trim(),
        fiatCurrency: currency,
        refundAccount: {
          institution: refund.institution,
          accountIdentifier: refund.accountIdentifier.trim(),
          accountName: refund.accountName.trim(),
        },
        buyer: buyerToSend,
        recipientAddress: recipient.trim() as `0x${string}`,
        reference: buildPaycrestReference("onramp", recipient.trim()),
      });
      void clearComposeDraft("buy");
    } catch {
      // surfaced via onramp.error
    }
  };
  const reviewBlocker =
    !recipientValid
      ? "Enter your wallet address"
      : (accountBlocker(refund, lookup) ?? (buyerProblems[0]?.replace(/\.$/, "") || null));

  // The token + chain picker, shared with the ChainRails flow.
  const chainPicker = (
    <>
      <TokenChainPill
        token={crDest ? "USDC" : token}
        chainName={crDest?.label ?? chainName}
        tokenLogo={<TokenLogo symbol={crDest ? "USDC" : token} size={z(28)} />}
        chainLogo={
          crDest ? (
            <RampLogo chainrailsChain={crDest.chainrailsChain} label={crDest.label} size={z(11)} />
          ) : (
            <ChainLogo id={chain} size={z(11)} />
          )
        }
        onPress={() => setChainOpen(true)}
      />
      <TokenChainSheet
        open={chainOpen}
        onClose={() => setChainOpen(false)}
        title="Receive on"
        hint="The chain your stablecoin lands on. Base, Arbitrum and Polygon have near-zero fees."
        token={crDest ? "USDC" : token}
        tokens={TOKENS}
        onTokenChange={(t) => {
          setToken(t as PaycrestToken);
          if (t === "USDT") setCrDest(null);
        }}
        chains={[
          ...tokenChains.map((id) => ({
            value: id,
            label: getChain(id)?.name ?? id,
            logo: <ChainLogo id={id} size={z(28)} />,
          })),
          ...((crDest ? "USDC" : token) === "USDC"
            ? CHAINRAILS_RAMP_DESTINATIONS.filter((d) => tokens.chainrails(d.chainrailsChain, "USDC")).map((d) => ({
                value: `cr:${d.chainrailsChain}`,
                label: d.label,
                logo: <RampLogo chainrailsChain={d.chainrailsChain} label={d.label} size={z(28)} />,
              }))
            : []),
        ]}
        value={crDest ? `cr:${crDest.chainrailsChain}` : chain}
        onSelect={(v) => {
          if (v.startsWith("cr:")) {
            const dest = CHAINRAILS_RAMP_DESTINATIONS.find((d) => `cr:${d.chainrailsChain}` === v);
            if (dest) setCrDest(dest);
            return;
          }
          setCrDest(null);
          setChain(v as ChainId);
        }}
      />
    </>
  );

  if (crDest) {
    return (
      <ChainrailsBuyFlow
        destination={crDest}
        resumeOrderId={crResumeId ?? undefined}
        chainPicker={chainPicker}
        onBack={() => {
          setCrDest(null);
          setCrResumeId(null);
        }}
      />
    );
  }

  if (onramp.status !== "idle") {
    return (
      <BuyOrder
        onramp={onramp}
        token={token}
        chain={chain}
        currency={currency}
        recipient={recipient}
        typedAmount={amountNum}
        todaysRate={rate}
        onNewOrder={() => {
          onramp.reset();
          setStep("amount");
        }}
        onNewDetails={() => {
          // Same amount, wallet and refund account at today's rate. Orders
          // reopened from History don't carry those, so go back to the form.
          onramp.reset();
          if (reviewBlocker === null && amountNum > 0) void createOrder();
          else setStep("amount");
        }}
      />
    );
  }

  // ---- 2. Review ----
  if (step === "review") {
    return (
      <FlowScreen onBack={() => setStep("amount")} backLabel="Back to amount">
        <StepProgress steps={STEPS} current={1} />
        <FlowHeader title="Review your purchase" />

        <Card>
          <View style={st.legs}>
            <View style={{ flex: 1 }}>
              <Text style={kitStyles.small}>You pay</Text>
              <Text style={st.legAmount}>{formatFiat(currency, amountNum)}</Text>
              <Text style={kitStyles.small}>{FIAT_INFO[currency]?.name ?? currency}</Text>
            </View>
            <Feather name="arrow-right" size={18} color={c.muted} />
            <View style={{ flex: 1, alignItems: "flex-end" }}>
              <Text style={kitStyles.small}>You receive</Text>
              <Text style={st.legAmount}>{estimate !== null ? `≈ ${formatToken(estimate, token, 2)}` : "—"}</Text>
              <Text style={kitStyles.small}>on {chainName}</Text>
            </View>
          </View>
          {rate ? (
            <DetailRows rows={[{ label: "Rate", value: `1 ${token} ≈ ${rate.toLocaleString("en-US")} ${currency}` }]} />
          ) : null}
          <View style={st.editRow}>
            <Text style={[kitStyles.small, { flex: 1 }]}>The rate locks on the next step and can move slightly.</Text>
            <TextLink label="Edit" onPress={() => setStep("amount")} />
          </View>
        </Card>

        <Card>
          <View style={{ gap: 6 }}>
            <FieldLabel>{`Receive ${token} to`}</FieldLabel>
            <TextField
              mono
              value={recipient}
              onChangeText={setRecipient}
              placeholder={`Your ${chainName} wallet address`}
              autoCapitalize="none"
            />
            {recipient.trim() && !recipientValid ? (
              <Text style={st.err}>That doesn&apos;t look like a valid {chainName} address.</Text>
            ) : null}
          </View>

          <View style={st.divider} />
          <View style={{ gap: 2 }}>
            <Text style={st.sectionTitle}>Refund account</Text>
            <Text style={kitStyles.small}>This account will be used for any refunds. Use one in your name.</Text>
          </View>
          <BankAccount
            currency={currency}
            value={refund}
            onChange={setRefund}
            onLookupChange={setLookup}
            wrongLabel="Not yours?"
          />

          <View style={st.divider} />
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
        </Card>

        {onramp.error ? <Notice tone="error">{onramp.error}</Notice> : null}
        <PrimaryButton
          label={reviewBlocker ?? "Continue to payment"}
          disabled={!!reviewBlocker}
          arrow
          onPress={() => void createOrder()}
        />
        <Text style={[kitStyles.small, { textAlign: "center" }]}>
          You&apos;ll see the account to pay into next. Your {token} arrives once the payment clears.
        </Text>
      </FlowScreen>
    );
  }

  // ---- 1. Amount ----
  return (
    <FlowScreen>
      <FlowHeader title="Buy crypto" subtitle="Pay with local currency, receive USDC in your wallet." />
      <StepProgress steps={STEPS} current={0} />

      <AmountCard
        label="You pay"
        value={amount}
        onChange={setAmount}
        pill={
          <>
            <CurrencyPill
              flag={FIAT_INFO[currency]?.flag ?? "🌍"}
              code={currency}
              country={FIAT_INFO[currency]?.country ?? currency}
              onPress={() => setCurrencyOpen(true)}
            />
            <CurrencySheet
              open={currencyOpen}
              onClose={() => setCurrencyOpen(false)}
              title="Pay with"
              value={currency}
              popular={PAYCREST_FIAT.map(currencyOption)}
              onSelect={(o) => setCurrency(o.value as PaycrestFiat)}
            />
          </>
        }
      />

      <RateLine rate={rate ? { from: `1 ${token}`, to: `${rate.toLocaleString("en-US")} ${currency}` } : null} />

      <AmountCard
        label="You receive"
        readOnly
        prefix="≈"
        value={estimate !== null ? estimate.toLocaleString("en-US", { maximumFractionDigits: 2 }) : ""}
        pill={chainPicker}
      />

      {estimate !== null ? (
        <Text style={kitStyles.small}>Estimate · final rate locks when you create the order</Text>
      ) : null}

      <PrimaryButton
        label={amountNum > 0 ? "Continue" : "Enter an amount"}
        disabled={!(amountNum > 0)}
        arrow
        onPress={() => setStep("review")}
      />
    </FlowScreen>
  );
}

/* ── 3. Pay: order status ───────────────────────────────────────────────── */

function BuyOrder({
  onramp,
  token,
  chain,
  currency,
  recipient,
  typedAmount,
  todaysRate,
  onNewOrder,
  onNewDetails,
}: {
  onramp: ReturnType<typeof usePaycrestOnramp>;
  token: PaycrestToken;
  chain: ChainId;
  currency: PaycrestFiat;
  recipient: string;
  typedAmount: number;
  todaysRate: number | null;
  onNewOrder: () => void;
  onNewDetails: () => void;
}) {
  const { status, order, error, depositSent, markSent } = onramp;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== "awaiting_deposit") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const chainName = getChain(chain)?.name ?? chain;
  const payCurrency = order?.depositCurrency ?? currency;
  const payLabel = order?.amountToTransfer ? formatFiat(payCurrency, order.amountToTransfer) : "—";
  const receiveLabel = order ? formatToken(Number(order.amount), token, 2) : "—";
  const deadline = order?.validUntil ?? null;
  const left = deadline ? Date.parse(deadline) - now : NaN;
  const countdown = Number.isFinite(left) && left > 0 ? formatCountdown(left) : null;
  const expiringSoon = Number.isFinite(left) && left > 0 && left < 5 * 60 * 1000;
  const to = order?.recipientAddress ?? recipient;

  const expired =
    !!order &&
    !paycrestOnrampPaid(order) &&
    (order.status === "expired" || (status === "error" && /expired/i.test(error ?? "")));

  if (status === "creating") {
    return (
      <FlowScreen>
        <StepProgress steps={STEPS} current={2} />
        <View style={st.center}>
          <ActivityIndicator size="large" color={c.ink} />
          <Text style={kitStyles.cardTitle}>Setting up your order…</Text>
          <Text style={kitStyles.small}>Locking your rate and opening an account for your payment.</Text>
        </View>
      </FlowScreen>
    );
  }

  if (expired && order) {
    const estimate = todaysRate && typedAmount > 0 ? typedAmount / todaysRate : null;
    return (
      <FlowScreen>
        <ExpiredOrder
          steps={STEPS}
          deadline={deadline}
          createdAt={order.createdAt}
          againTitle="Buy again at today's rate"
          againSub="Same amount, wallet and bank details. You'll get new payment details and a fresh time limit."
          payLabel="You pay"
          payAmount={typedAmount > 0 ? formatFiat(currency, typedAmount) : payLabel}
          receiveLabel="You receive about"
          receiveAmount={estimate !== null ? formatToken(estimate, token, 2) : null}
          rateLine={todaysRate ? `1 ${token} ≈ ${todaysRate.toLocaleString("en-US")} ${currency}` : null}
          primaryLabel="Get new payment details"
          onPrimary={onNewDetails}
          secondaryLabel="Change amount"
          onSecondary={onNewOrder}
          quoteRows={[
            ...(order.amountToTransfer ? [{ label: "You were paying", value: payLabel }] : []),
            ...(order.rate ? [{ label: "Rate", value: `1 ${token} = ${Number(order.rate).toLocaleString("en-US")} ${currency}` }] : []),
            { label: "You'd have received", value: receiveLabel },
            ...(to ? [{ label: "To", value: `${short0x(to)} · ${chainName}` }] : []),
          ]}
          orderId={order.id}
        />
      </FlowScreen>
    );
  }

  if (status === "complete") {
    return (
      <FlowScreen>
        <StepProgress steps={STEPS} current={3} />
        <Card style={{ alignItems: "center", overflow: "hidden" }}>
          <Confetti />
          <SuccessCheck />
          <Text style={st.doneAmount}>{receiveLabel}</Text>
          <Text style={[kitStyles.small, { textAlign: "center" }]}>
            {to ? `in your wallet ${short0x(to)} on ${chainName}` : `on ${chainName}`}
          </Text>
          {order ? <Text style={st.orderId} selectable>Order {order.id}</Text> : null}
        </Card>
        <PrimaryButton label="Buy again" onPress={onNewOrder} arrow />
      </FlowScreen>
    );
  }

  if (status === "error" && !order) {
    return (
      <FlowScreen>
        <StepProgress steps={STEPS} current={2} />
        <FlowHeader title="Couldn't create this order" />
        <Notice tone="error">{error ?? "Please try again."}</Notice>
        <PrimaryButton label="Try again" onPress={onNewOrder} />
      </FlowScreen>
    );
  }

  const waiting = status === "awaiting_deposit";
  const stages = [
    { l: "Rate locked", d: "We've opened an account for your payment." },
    { l: "Waiting for your payment", d: "This page updates on its own when it arrives." },
    { l: `Sending your ${token}`, d: "Starts once your payment is confirmed." },
    { l: `You receive ${token}`, d: `In your wallet on ${chainName}.` },
  ];

  return (
    <FlowScreen>
      <StepProgress steps={STEPS} current={2} />
      <FlowHeader
        title={waiting ? `Pay ${payLabel} to finish` : `Payment received — sending your ${token}`}
        subtitle={waiting ? `You get ${receiveLabel} on ${chainName} once it arrives.` : undefined}
      />
      {waiting && countdown ? (
        <View style={[st.timer, expiringSoon && st.timerSoon]}>
          <Feather name="clock" size={15} color={expiringSoon ? c.danger : c.warnStrong} />
          <Text style={[st.timerText, expiringSoon && { color: c.danger }]}>
            {countdown} left{deadline ? ` · pay by ${clockTime(deadline)}` : ""}
          </Text>
        </View>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {waiting && order?.depositAccountIdentifier ? (
        <Card primary>
          <Text style={kitStyles.cardTitle}>Pay into this account</Text>
          <Text style={kitStyles.small}>Send the exact amount in one transfer from your bank app.</Text>
          <CopyRow label="Amount" value={payLabel} copyText={String(order.amountToTransfer ?? "")} />
          <CopyRow
            label="Account number"
            value={order.depositAccountIdentifier}
            copyText={order.depositAccountIdentifier}
            mono
          />
          <DetailRows
            rows={[
              ...(order.depositInstitution ? [{ label: "Bank", value: order.depositInstitution }] : []),
              ...(order.depositAccountName ? [{ label: "Account name", value: order.depositAccountName }] : []),
            ]}
          />
          {depositSent ? (
            <View style={st.checking}>
              <ActivityIndicator size="small" color={c.muted} />
              <Text style={kitStyles.small}>Confirming your payment — this can take a few minutes.</Text>
            </View>
          ) : (
            <SecondaryButton label="I've sent the payment" onPress={markSent} />
          )}
        </Card>
      ) : null}

      {order ? (
        <Card>
          <View style={st.cardHead}>
            <Text style={kitStyles.cardTitle}>Locked quote</Text>
            <View style={st.locked}>
              <Feather name="check" size={13} color={c.success} />
              <Text style={st.lockedText}>Rate locked</Text>
            </View>
          </View>
          <DetailRows
            rows={[
              { label: "You pay", value: payLabel },
              ...(order.rate ? [{ label: "Rate", value: `1 ${token} = ${Number(order.rate).toLocaleString("en-US")} ${currency}` }] : []),
              { label: "You receive", value: receiveLabel },
              ...(to ? [{ label: "To", value: `${short0x(to)} on ${chainName}` }] : []),
            ]}
          />
        </Card>
      ) : null}

      <Card>
        <Text style={kitStyles.cardTitle}>Progress</Text>
        <ProgressList stages={stages} activeIndex={waiting ? 1 : 2} failed={status === "error"} />
        {order ? <Text style={st.orderId} selectable>Order {order.id}</Text> : null}
      </Card>

      {status === "error" ? <SecondaryButton label="Back to Buy" onPress={onNewOrder} /> : null}
    </FlowScreen>
  );
}

/** 2_940_000 ms → "49:00". */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const st = StyleSheet.create({
  legs: { flexDirection: "row", alignItems: "center", gap: z(12) },
  legAmount: { color: c.ink, fontSize: zf(18), fontWeight: "600" },
  editRow: { flexDirection: "row", alignItems: "center", gap: z(12), borderTopWidth: 1, borderTopColor: c.edgeSoft, paddingTop: z(12) },
  divider: { height: z(1), backgroundColor: c.edgeSoft },
  sectionTitle: { color: c.ink, fontSize: zf(15), fontWeight: "600" },
  err: { color: c.danger, fontSize: zf(13) },
  center: { alignItems: "center", gap: z(10), paddingVertical: z(48) },
  doneAmount: { color: c.ink, fontSize: zf(30), fontWeight: "600", marginTop: z(8) },
  orderId: { color: c.muted, fontSize: zf(12), fontFamily: "Menlo" },
  timer: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(8),
    alignSelf: "flex-start",
    height: z(36),
    paddingHorizontal: z(14),
    borderRadius: z(999),
    backgroundColor: c.warnBg,
  },
  timerSoon: { backgroundColor: "#FDE8E6" },
  timerText: { color: c.warnStrong, fontSize: zf(14), fontWeight: "600" },
  checking: { flexDirection: "row", alignItems: "center", gap: z(8) },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  locked: { flexDirection: "row", alignItems: "center", gap: z(4) },
  lockedText: { color: c.success, fontSize: zf(13), fontWeight: "500" },
});
