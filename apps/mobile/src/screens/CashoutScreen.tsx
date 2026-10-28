// Sell (stablecoin → bank / mobile money), in the redesign's layout:
//   1. Amount  — "You send" with token + chain, rate, "They receive", fees
//   2. Recipient — "Who's getting the money?": bank, account, name check,
//      save to Recipients, refund address
//   3. Send — order status: pay from wallet or deposit address + QR, locked
//      quote, progress, countdown (or the calm expired page)
// Mirrors the website's CashoutFlow → SellReview → PaycrestOrderScreen.
import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useAccount, useBalance } from "wagmi";
import { Feather } from "@expo/vector-icons";
import {
  ACTIVE_CHAINS,
  getChain,
  getTokenAddress,
  resolveChain,
  type ChainId,
} from "@railglide/shared/network";
import { PAYCREST_SENDER_FEE_PERCENT, amountBeforeFee } from "@railglide/shared/fees";
import { useSession } from "@/store/session";
import { useRecipients } from "@/store/recipients";
import { usePaycrestOfframp } from "@/wallet/usePaycrestOfframp";
import { getRate } from "@/api/paycrest";
import {
  buildPaycrestReference,
  paycrestAmountDue,
  PAYCREST_CHAIN_IDS,
  PAYCREST_FIAT,
  type PaycrestFiat,
  type PaycrestToken,
} from "@/rails/paycrest";
import { FIAT_INFO, formatFiat, formatToken } from "@/lib/format";
import { clearComposeDraft, loadComposeDraft, saveComposeDraft } from "@/lib/composeDraft";
import { useTokenSupport } from "@/lib/useTokenSupport";
import { TokenLogo, ChainLogo } from "@/components/Logo";
import { Confetti } from "@/components/Confetti";
import { SuccessCheck } from "@/components/SuccessCheck";
import { PickerSheet } from "@/components/PickerSheet";
import { CurrencySheet, TokenChainSheet, type CurrencyOption } from "@/components/flowPickers";
import {
  BankAccount,
  EMPTY_ACCOUNT,
  accountBlocker,
  titleCase,
  type BankAccountValue,
  type LookupState,
} from "@/components/BankAccount";
import { ExpiredOrder } from "@/components/ExpiredOrder";
import {
  AmountCard,
  BalanceAside,
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
  QrCode,
  RateLine,
  SecondaryButton,
  StepProgress,
  SummaryRows,
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
const STEPS = ["Amount", "Recipient", "Send"];

/** Chains that are both in the active network universe and Paycrest-supported. */
function offrampChains(): ChainId[] {
  return PAYCREST_CHAIN_IDS.filter((id) => ACTIVE_CHAINS.some((ch) => ch.id === id));
}

const currencyOption = (code: string): CurrencyOption => ({
  value: code,
  code,
  flag: FIAT_INFO[code]?.flag ?? "🌍",
  country: FIAT_INFO[code]?.country ?? code,
  name: FIAT_INFO[code]?.name ?? code,
});

type Step = "amount" | "recipient";

export function CashoutScreen() {
  const launch = useSession((s) => s.pendingLaunch);
  const setPendingLaunch = useSession((s) => s.setPendingLaunch);
  const resumeOrder = useSession((s) => s.resumeOrder);
  const setResumeOrder = useSession((s) => s.setResumeOrder);
  const { address, isConnected } = useAccount();
  const offramp = usePaycrestOfframp();
  const recipients = useRecipients();

  const chains = useMemo(offrampChains, []);
  const [step, setStep] = useState<Step>("amount");

  // ---- Amount ----
  const [amount, setAmount] = useState(launch?.amount ?? "");
  const [token, setToken] = useState<PaycrestToken>(
    (launch?.token as PaycrestToken) === "USDT" ? "USDT" : "USDC"
  );
  const [chain, setChain] = useState<ChainId>(
    (launch?.chain && resolveChain(launch.chain)) || chains[0]
  );
  const [currency, setCurrency] = useState<PaycrestFiat>(
    (launch?.currency as PaycrestFiat) && PAYCREST_FIAT.includes(launch!.currency as PaycrestFiat)
      ? (launch!.currency as PaycrestFiat)
      : "NGN"
  );
  const [rate, setRate] = useState<number | null>(null);
  const [chainOpen, setChainOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);

  // ---- Recipient ----
  const [payout, setPayout] = useState<BankAccountValue>(EMPTY_ACCOUNT);
  const [lookup, setLookup] = useState<LookupState>("idle");
  const [saveRecipient, setSaveRecipient] = useState(true);
  const [savedOpen, setSavedOpen] = useState(false);
  const [refund, setRefund] = useState(address ?? "");

  // Clear the one-shot handoff so leaving and returning starts fresh.
  useEffect(() => () => setPendingLaunch(null), [setPendingLaunch]);

  useEffect(() => {
    if (!recipients.hydrated) void recipients.hydrate();
  }, [recipients]);

  useEffect(() => {
    if (address) setRefund((cur) => cur || address);
  }, [address]);

  // Restore a half-filled Sell form (prior visit / app restart). A chat launch
  // wins. `hydrated` stops the save effect clobbering the draft before restore.
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
          if (d.chain && chains.includes(d.chain as ChainId)) setChain(d.chain as ChainId);
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

  // Live sell rate for the estimate (the exact rate locks on the order).
  useEffect(() => {
    let cancelled = false;
    getRate(currency, token, "sell")
      .then((r) => !cancelled && setRate(r.rate))
      .catch(() => !cancelled && setRate(null));
    return () => {
      cancelled = true;
    };
  }, [currency, token]);

  // Only chains where Paycrest supports the token (live list, with a built-in
  // fallback) and we have its contract address to send from.
  const tokens = useTokenSupport();
  const tokenChains = chains.filter(
    (id) => !!getTokenAddress(token, id) && tokens.paycrest(id, token)
  );
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
    query: { enabled: isConnected && !!tokenAddress && !!viemChainId },
  });
  const balance = balanceQuery.data ? Math.floor(Number(balanceQuery.data.formatted) * 100) / 100 : null;

  const amountNum = Number(amount) || 0;
  // The fee comes out of what they send: 800 → 796.02 converted.
  const converted = amountNum > 0 ? amountBeforeFee(amountNum) : 0;
  const fee = amountNum - converted;
  const estimate = rate && amountNum > 0 ? converted * rate : null;
  const overBalance = balance != null && amountNum > balance;
  const chainName = getChain(chain)?.name ?? chain;

  // Saved recipients for this currency.
  const saved = recipients.recipients.filter((r) => r.currency === currency);
  const acct = payout.accountIdentifier.trim();
  const alreadySaved = saved.some((r) => r.institution === payout.institution && r.accountIdentifier === acct);
  const refundValid = /^0x[0-9a-fA-F]{40}$/.test(refund.trim());
  const name = payout.accountName.trim();

  const createOrder = async () => {
    try {
      if (saveRecipient && !alreadySaved) {
        void recipients.upsert({
          name,
          currency,
          institution: payout.institution,
          institutionName: payout.institutionName,
          accountIdentifier: acct,
          accountName: name,
        });
      }
      await offramp.offramp({
        fromChain: chain,
        token,
        amount: amount.trim(),
        fiatCurrency: currency,
        recipient: { institution: payout.institution, accountIdentifier: acct, accountName: name },
        refundAddress: refund.trim() as `0x${string}`,
        reference: buildPaycrestReference("offramp", refund.trim()),
      });
      // Order placed — drop the saved draft so a fresh sale starts clean.
      void clearComposeDraft("cashout");
    } catch {
      // error surfaced via offramp.error
    }
  };

  // ---- Order in flight ----
  if (offramp.status !== "idle") {
    return (
      <SellOrder
        offramp={offramp}
        token={token}
        currency={currency}
        chain={chain}
        payout={payout}
        onSellAgain={() => {
          offramp.reset();
          setStep("amount");
        }}
        onNewDetails={() => {
          // Same amount and recipient: new rate + deposit address. Orders
          // reopened from History don't carry the recipient, so go back.
          offramp.reset();
          if (accountBlocker(payout, lookup) === null && refundValid) void createOrder();
          else setStep("amount");
        }}
      />
    );
  }

  const tokenChainPill = (
    <>
      <TokenChainPill
        token={token}
        chainName={chainName}
        tokenLogo={<TokenLogo symbol={token} size={z(28)} />}
        chainLogo={<ChainLogo id={chain} size={z(11)} />}
        onPress={() => setChainOpen(true)}
      />
      <TokenChainSheet
        open={chainOpen}
        onClose={() => setChainOpen(false)}
        title="Send from"
        hint="Select the chain where you have the USDC/USDT you're going to use."
        token={token}
        tokens={TOKENS}
        onTokenChange={(t) => setToken(t as PaycrestToken)}
        chains={tokenChains.map((id) => ({
          value: id,
          label: getChain(id)?.name ?? id,
          logo: <ChainLogo id={id} size={z(28)} />,
        }))}
        value={chain}
        onSelect={(v) => setChain(v as ChainId)}
      />
    </>
  );

  // ---- 2. Recipient ----
  if (step === "recipient") {
    const blocker = accountBlocker(payout, lookup) ?? (!refundValid ? "Enter a refund address" : null);
    return (
      <FlowScreen onBack={() => setStep("amount")} backLabel="Back to amount">
        <StepProgress steps={STEPS} current={1} />
        <FlowHeader title="Who's getting the money?" />

        <Card>
          <View style={st.legs}>
            <View style={{ flex: 1 }}>
              <Text style={kitStyles.small}>You send</Text>
              <Text style={st.legAmount}>{formatToken(amountNum, token, 2)}</Text>
              <Text style={kitStyles.small}>on {chainName}</Text>
            </View>
            <Feather name="arrow-right" size={18} color={c.muted} />
            <View style={{ flex: 1, alignItems: "flex-end" }}>
              <Text style={kitStyles.small}>Recipient gets</Text>
              <Text style={st.legAmount}>{estimate !== null ? `≈ ${formatFiat(currency, estimate)}` : "—"}</Text>
              <Text style={kitStyles.small}>{FIAT_INFO[currency]?.name ?? currency}</Text>
            </View>
          </View>
          <DetailRows
            rows={[
              { label: `Fee (${PAYCREST_SENDER_FEE_PERCENT}%)`, value: formatToken(fee, token, 2) },
              { label: "Amount converted", value: formatToken(converted, token, 2) },
              ...(rate ? [{ label: "Rate", value: `1 ${token} ≈ ${rate.toLocaleString("en-US")} ${currency}` }] : []),
            ]}
          />
          <View style={st.editRow}>
            <Text style={[kitStyles.small, { flex: 1 }]}>
              The fee is fixed. The rate locks on the next step and can move slightly.
            </Text>
            <TextLink label="Edit" onPress={() => setStep("amount")} />
          </View>
        </Card>

        <Card>
          <View style={st.cardHead}>
            <Text style={kitStyles.cardTitle}>Payout account</Text>
            {saved.length > 0 && (
              <Pressable style={st.savedBtn} onPress={() => setSavedOpen(true)}>
                <Feather name="users" size={14} color={c.ink} />
                <Text style={st.savedText}>Saved</Text>
              </Pressable>
            )}
          </View>
          <PickerSheet
            open={savedOpen}
            onClose={() => setSavedOpen(false)}
            title="Saved recipients"
            searchPlaceholder="Search name or account"
            onSelect={(id) => {
              const r = saved.find((x) => x.id === id);
              if (r)
                setPayout({
                  institution: r.institution,
                  institutionName: r.institutionName,
                  accountIdentifier: r.accountIdentifier,
                  accountName: r.accountName,
                });
            }}
            groups={[
              {
                items: saved.map((r) => ({
                  value: r.id,
                  title: titleCase(r.accountName || r.name),
                  subtitle: `${r.institutionName} · ${r.accountIdentifier}`,
                })),
              },
            ]}
          />

          <BankAccount
            currency={currency}
            value={payout}
            onChange={setPayout}
            onLookupChange={setLookup}
            wrongLabel="Not them?"
          />

          {name && !alreadySaved ? (
            <Pressable style={st.checkRow} onPress={() => setSaveRecipient((v) => !v)}>
              <View style={[st.checkbox, saveRecipient && st.checkboxOn]}>
                {saveRecipient && <Feather name="check" size={13} color="#fff" />}
              </View>
              <Text style={st.checkText}>Save {titleCase(name).split(" ")[0]} to Recipients</Text>
            </Pressable>
          ) : null}

          <View style={st.divider} />
          <View style={{ gap: 6 }}>
            <FieldLabel>Refund address</FieldLabel>
            <TextField
              mono
              value={refund}
              onChangeText={setRefund}
              placeholder="0x… wallet address"
              autoCapitalize="none"
            />
            <Text style={kitStyles.small}>
              {refund.trim() && !refundValid
                ? "That doesn't look like a valid wallet address."
                : "This wallet will be used for any refunds."}
            </Text>
          </View>
        </Card>

        {offramp.error ? <Notice tone="error">{offramp.error}</Notice> : null}
        <PrimaryButton
          label={blocker ?? "Lock rate and get deposit address"}
          disabled={!!blocker}
          arrow
          onPress={() => void createOrder()}
        />
        <Text style={[kitStyles.small, { textAlign: "center" }]}>
          Nothing leaves your wallet until you send it on the next step.
        </Text>
      </FlowScreen>
    );
  }

  // ---- 1. Amount ----
  return (
    <FlowScreen>
      <FlowHeader title="Send money" subtitle="Pay a bank or mobile money account with your stablecoins." />
      <StepProgress steps={STEPS} current={0} />

      <AmountCard
        label="You send"
        value={amount}
        onChange={setAmount}
        aside={
          isConnected && balance != null ? (
            <BalanceAside
              label={formatToken(balance, token, 2)}
              showMax={balance > 0}
              onMax={() => setAmount(String(balance))}
            />
          ) : undefined
        }
        pill={tokenChainPill}
      >
        {overBalance ? (
          <Text style={st.warn}>More than this wallet holds. You can still continue and pay from another wallet.</Text>
        ) : null}
      </AmountCard>

      <RateLine rate={rate ? { from: `1 ${token}`, to: `${rate.toLocaleString("en-US")} ${currency}` } : null} />

      <AmountCard
        label="They receive"
        readOnly
        prefix="≈"
        value={estimate !== null ? estimate.toLocaleString("en-US", { maximumFractionDigits: 2 }) : ""}
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
              title="Recipient gets paid in"
              value={currency}
              popular={PAYCREST_FIAT.map(currencyOption)}
              onSelect={(o) => setCurrency(o.value as PaycrestFiat)}
            />
          </>
        }
      />

      {amountNum > 0 && (
        <>
          <SummaryRows
            rows={[
              { label: `Fee (${PAYCREST_SENDER_FEE_PERCENT}%)`, value: formatToken(fee, token, 2) },
              { label: "Amount converted", value: formatToken(converted, token, 2) },
              { label: "Total from your wallet", value: formatToken(amountNum, token, 2), total: true },
            ]}
          />
          <Text style={kitStyles.small}>Estimate · final rate locks when you create the order</Text>
        </>
      )}

      <PrimaryButton
        label={amountNum > 0 ? "Continue to recipient" : "Enter an amount"}
        disabled={!(amountNum > 0)}
        arrow
        onPress={() => setStep("recipient")}
      />
    </FlowScreen>
  );
}

/* ── 3. Order status ─────────────────────────────────────────────────────── */

function SellOrder({
  offramp,
  token,
  currency,
  chain,
  payout,
  onSellAgain,
  onNewDetails,
}: {
  offramp: ReturnType<typeof usePaycrestOfframp>;
  token: PaycrestToken;
  currency: PaycrestFiat;
  chain: ChainId;
  payout: BankAccountValue;
  onSellAgain: () => void;
  onNewDetails: () => void;
}) {
  const { status, order, error, fund, fundable, manualCheck, markSent, transferTxHash } = offramp;

  // One countdown from the order's deadline, ticking while we wait.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== "awaiting_funding") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const chainName = getChain(chain)?.name ?? chain;
  const due = order ? Number(paycrestAmountDue(order)) : 0;
  const dueLabel = formatToken(due, token, 2);
  const fiat = order && Number(order.rate) > 0 ? Number(order.amount) * Number(order.rate) : null;
  const fiatLabel = fiat !== null ? formatFiat(currency, fiat) : "—";
  const name = payout.accountName ? titleCase(payout.accountName) : null;
  const firstName = name?.split(" ")[0];
  const deadline = order?.validUntil ?? null;
  const left = deadline ? Date.parse(deadline) - now : NaN;
  const countdown = Number.isFinite(left) && left > 0 ? formatCountdown(left) : null;
  const expiringSoon = Number.isFinite(left) && left > 0 && left < 5 * 60 * 1000;

  const expired =
    !!order &&
    (order.status === "expired" || (status === "error" && /expired/i.test(error ?? "")));
  const refunded = !!order && order.status === "refunded";

  if (status === "creating") {
    return (
      <FlowScreen>
        <StepProgress steps={STEPS} current={2} />
        <View style={st.center}>
          <ActivityIndicator size="large" color={c.ink} />
          <Text style={kitStyles.cardTitle}>Setting up your order…</Text>
          <Text style={kitStyles.small}>Locking your rate and preparing the deposit.</Text>
        </View>
      </FlowScreen>
    );
  }

  if (expired && order) {
    return (
      <FlowScreen>
        <ExpiredOrder
          steps={STEPS}
          deadline={deadline}
          createdAt={order.createdAt}
          againTitle="Sell again at today's rate"
          againSub="Same amount and recipient. You'll get a new deposit address and a fresh time limit."
          payLabel="You send"
          payAmount={dueLabel}
          receiveLabel="They receive about"
          receiveAmount={null}
          rateLine="Today's rate shows on the next step"
          primaryLabel="Get new deposit address"
          onPrimary={onNewDetails}
          secondaryLabel="Change amount"
          onSecondary={onSellAgain}
          quoteRows={[
            { label: "You were sending", value: dueLabel },
            ...(order.rate ? [{ label: "Rate", value: `1 ${token} = ${Number(order.rate).toLocaleString("en-US")} ${currency}` }] : []),
            { label: "They'd have received", value: fiatLabel },
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
          <Text style={st.doneAmount}>{fiatLabel}</Text>
          <Text style={[kitStyles.small, { textAlign: "center" }]}>
            {name ? `delivered to ${name}` : "delivered"}
            {payout.institutionName ? ` · ${payout.institutionName}` : ""}
          </Text>
          {order ? <Text style={st.orderId} selectable>Order {order.id}</Text> : null}
        </Card>
        <PrimaryButton label="Sell again" onPress={onSellAgain} arrow />
      </FlowScreen>
    );
  }

  if (status === "error" && !order) {
    return (
      <FlowScreen>
        <StepProgress steps={STEPS} current={2} />
        <FlowHeader title="Couldn't create this order" />
        <Notice tone="error">{error ?? "Please try again."}</Notice>
        <PrimaryButton label="Try again" onPress={onSellAgain} />
      </FlowScreen>
    );
  }

  const waiting = status === "awaiting_funding";
  const activeIndex = status === "settling" ? 2 : 1;
  const stages = [
    { l: "Rate locked", d: deadline ? `Send your ${token} before ${clockTime(deadline)}.` : "Your rate is held." },
    {
      l: status === "funding" ? `Sending your ${token}` : `Waiting for your ${token}`,
      d: status === "funding" ? "Confirm in your wallet." : "This page updates on its own when it arrives.",
    },
    { l: "Converting and paying out", d: `Starts once your ${token} is confirmed.` },
    {
      l: `${firstName ?? "The recipient"} receives ${fiatLabel}`,
      d: [payout.institutionName, payout.accountIdentifier].filter(Boolean).join(" · ") || "Delivered to the recipient.",
    },
  ];

  return (
    <FlowScreen>
      <StepProgress steps={STEPS} current={2} />
      <FlowHeader
        title={
          refunded
            ? "Refunded"
            : waiting
              ? `Send ${dueLabel} to finish`
              : status === "funding"
                ? "Confirm in your wallet"
                : "Paying the recipient"
        }
        subtitle={waiting && name ? `${name} gets ${fiatLabel} once it arrives.` : undefined}
      />
      {waiting && countdown ? (
        <View style={[st.timer, expiringSoon && st.timerSoon]}>
          <Feather name="clock" size={15} color={expiringSoon ? c.danger : c.warnStrong} />
          <Text style={[st.timerText, expiringSoon && { color: c.danger }]}>
            {countdown} left{deadline ? ` · send by ${clockTime(deadline)}` : ""}
          </Text>
        </View>
      ) : null}

      {refunded ? (
        <Notice tone="info">This order couldn&apos;t be completed, so your deposit went back to your wallet.</Notice>
      ) : null}
      {error && !refunded ? <Notice tone="error">{error}</Notice> : null}

      {waiting && order?.receiveAddress ? (
        <>
          <Text style={kitStyles.cardTitle}>Choose how to send it</Text>
          {fundable ? (
            <Card>
              <Text style={st.optTitle}>From your connected wallet</Text>
              <PrimaryButton label={`Send ${dueLabel}`} onPress={() => void fund()} arrow />
            </Card>
          ) : null}
          <Card primary={!fundable}>
            <Text style={st.optTitle}>From an exchange or another wallet</Text>
            <Text style={st.onlyChip}>
              {token} on <Text style={{ fontWeight: "700" }}>{chainName}</Text> only, in one transfer
            </Text>
            <CopyRow label="Amount" value={dueLabel} copyText={String(due)} />
            <CopyRow label="Address" value={order.receiveAddress} copyText={order.receiveAddress} mono />
            <View style={{ alignItems: "center", gap: 6 }}>
              <QrCode value={order.receiveAddress} size={140} />
              <Text style={kitStyles.small}>Scan from an exchange app</Text>
            </View>
            <Text style={kitStyles.small}>
              Exchanges may deduct a withdrawal fee. Make sure the full {dueLabel} arrives, or the
              order is refunded.
            </Text>
            {manualCheck ? (
              <Text style={kitStyles.small}>Checking for your transfer…</Text>
            ) : (
              <SecondaryButton label="I've sent the payment" onPress={markSent} />
            )}
          </Card>
        </>
      ) : null}

      {transferTxHash ? <Text style={kitStyles.small}>Payment sent · {short0x(transferTxHash)}</Text> : null}

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
              { label: "You send", value: dueLabel },
              ...(Number(order.senderFee) > 0
                ? [{ label: `Fee (${PAYCREST_SENDER_FEE_PERCENT}%)`, value: formatToken(Number(order.senderFee), token, 2) }]
                : []),
              { label: "Amount converted", value: formatToken(Number(order.amount), token, 2) },
              ...(order.rate ? [{ label: "Rate", value: `1 ${token} = ${Number(order.rate).toLocaleString("en-US")} ${currency}` }] : []),
              { label: "They receive", value: fiatLabel },
              ...(name ? [{ label: "Paid to", value: [name, payout.institutionName, payout.accountIdentifier].filter(Boolean).join(" · ") }] : []),
            ]}
          />
        </Card>
      ) : null}

      <Card>
        <Text style={kitStyles.cardTitle}>Progress</Text>
        <ProgressList stages={stages} activeIndex={activeIndex} failed={!!error && !refunded} />
        {order ? <Text style={st.orderId} selectable>Order {order.id}</Text> : null}
      </Card>

      {status === "error" ? <SecondaryButton label="Back to Sell" onPress={onSellAgain} /> : null}
    </FlowScreen>
  );
}

/** 2_940_000 ms → "49:00". */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const st = StyleSheet.create({
  legs: { flexDirection: "row", alignItems: "center", gap: z(12) },
  legAmount: { color: c.ink, fontSize: zf(18), fontWeight: "600" },
  editRow: { flexDirection: "row", alignItems: "center", gap: z(12), borderTopWidth: 1, borderTopColor: c.edgeSoft, paddingTop: z(12) },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  savedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(6),
    height: z(36),
    paddingHorizontal: z(12),
    borderRadius: z(999),
    borderWidth: 1,
    borderColor: c.edge,
    backgroundColor: c.pill,
  },
  savedText: { color: c.ink, fontSize: zf(13), fontWeight: "600" },
  checkRow: { flexDirection: "row", alignItems: "center", gap: z(10), minHeight: z(44) },
  checkbox: { width: z(20), height: z(20), borderRadius: z(5), borderWidth: 1.5, borderColor: c.stepRing, alignItems: "center", justifyContent: "center" },
  checkboxOn: { backgroundColor: c.ink, borderColor: c.ink },
  checkText: { color: c.ink, fontSize: zf(14) },
  divider: { height: z(1), backgroundColor: c.edgeSoft },
  warn: { color: c.warnInk, fontSize: zf(13), lineHeight: z(18) },
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
  optTitle: { color: c.ink, fontSize: zf(15), fontWeight: "600" },
  onlyChip: { color: c.warnInk, fontSize: zf(13) },
  locked: { flexDirection: "row", alignItems: "center", gap: z(4) },
  lockedText: { color: c.success, fontSize: zf(13), fontWeight: "500" },
});
