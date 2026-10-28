import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ActivityIndicator, Linking, StyleSheet, type ViewProps } from "react-native";
import {
  createRampOrder,
  getRampCountries,
  getRampQuote,
  getRampOrder,
  type RampCountry,
  type RampFieldSpec,
  type RampOrder,
} from "@/api/chainrails";
import {
  classifyRampStatus,
  isRampPhaseTerminal,
  isValidRampAddress,
  rampTxUrl,
  type RampDestination,
  type RampOrderPhase,
} from "@/rails/chainrails";
import { PAYCREST_FIAT, type PaycrestFiat } from "@/rails/paycrest";
import { ApiError } from "@/api/client";
import { pollRampOrder } from "@/lib/rampPoll";
import { useRampOrders } from "@/store/rampOrders";
import { Picker } from "@/components/Picker";
import { Confetti } from "@/components/Confetti";
import { SuccessCheck } from "@/components/SuccessCheck";
import { CurrencySheet, type CurrencyOption } from "@/components/flowPickers";
import { BankAccount } from "@/components/BankAccount";
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
  kitStyles,
  short0x,
} from "@/components/kit";
import {
  clearChainrailsRampDraft,
  loadChainrailsRampDraft,
  loadSavedEmail,
  saveChainrailsRampDraft,
  saveSavedEmail,
} from "@/lib/composeDraft";
import { flagEmoji, formatToken } from "@/lib/format";
import { theme, z, zf } from "@/theme";

const c = theme.flow;
const STEPS = ["Amount", "Review", "Pay"];

/** Loose email check — enough to catch typos before we hit the provider. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A small crypto amount to probe the corridor's rate with. The rate is amount-
// independent, so this only needs to clear the provider minimum.
const RATE_PROBE_CRYPTO = 10;

/** fiat per 1 USDC, tolerant of both response shapes. */
function quoteRate(q: {
  exchangeRate?: number;
  exchangeRatePerUSD?: number;
}): number {
  return q.exchangeRate ?? q.exchangeRatePerUSD ?? 0;
}

/**
 * ChainrailsBuyFlow — Buy body for chains Paycrest can't reach. The user pays
 * local currency and their USDC is delivered to a pasted address; payment is
 * completed in the provider's hosted checkout (opened in the system browser).
 */
export function ChainrailsBuyFlow({
  destination,
  onBack,
  resumeOrderId,
  chainPicker,
}: {
  destination: RampDestination;
  onBack: () => void;
  /** The Buy screen's token + chain pill, shown in "You receive". */
  chainPicker?: ViewProps["children"];
  /** When set, load this existing order and show its status (from History). */
  resumeOrderId?: string;
}) {
  const trackedOrders = useRampOrders((s) => s.orders);
  const [countries, setCountries] = useState<RampCountry[]>([]);
  const [countryCode, setCountryCode] = useState("NG");
  const [amount, setAmount] = useState(""); // fiat the user pays
  const [unitRate, setUnitRate] = useState<number | null>(null); // fiat per USDC
  const [fields, setFields] = useState<RampFieldSpec[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [address, setAddress] = useState("");
  // Contact/KYC email — required for the order (PAYCREST 400s without it).
  // Remembered on-device and reused across buys.
  const [email, setEmail] = useState("");

  const [loading, setLoading] = useState(true);
  const [rateLoading, setRateLoading] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [order, setOrder] = useState<RampOrder | null>(null);
  const [phase, setPhase] = useState<RampOrderPhase>("pending");
  // We only poll once the user has opened the checkout; the shared poller then
  // pauses while the app is backgrounded (i.e. while they're paying in Safari)
  // and fires immediately when they return.
  const [polling, setPolling] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  // Display name of the chosen refund bank (the order only takes its code).
  const [refundBankName, setRefundBankName] = useState("");

  // Prefill the remembered email so a returning buyer doesn't retype it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await loadSavedEmail();
      if (!cancelled && saved) setEmail(saved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the currency catalogue once.
  useEffect(() => {
    let cancelled = false;
    getRampCountries()
      .then((list) => {
        if (cancelled) return;
        setCountries(list);
        if (!list.some((c) => c.countryCode === "NG") && list[0])
          setCountryCode(list[0].countryCode);
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof ApiError ? err.message : "Couldn't load countries."
          );
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore a half-filled panel (amount, country, provider fields, address) so
  // nothing has to be retyped. Kept per corridor chain. The dynamic field list
  // is re-fetched by the rate probe below; it merges onto these. `hydrated`
  // gates the save effect so it can't clobber the draft with blank state first.
  const hydrated = useRef(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!resumeOrderId) {
        const d = await loadChainrailsRampDraft(destination.chainrailsChain);
        if (active && d) {
          if (d.amount) setAmount(d.amount);
          if (d.countryCode) setCountryCode(d.countryCode);
          if (d.fields) setFieldValues(d.fields);
          if (d.address) setAddress(d.address);
        }
      }
      hydrated.current = true;
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination.chainrailsChain]);

  useEffect(() => {
    if (!hydrated.current) return;
    void saveChainrailsRampDraft(destination.chainrailsChain, {
      amount,
      countryCode,
      fields: fieldValues,
      address,
    });
  }, [destination.chainrailsChain, amount, countryCode, fieldValues, address]);

  const country = useMemo(
    () => countries.find((c) => c.countryCode === countryCode),
    [countries, countryCode]
  );

  // Probe one quote per country/chain to learn the rate + the provider fields.
  useEffect(() => {
    if (!country) return;
    let cancelled = false;
    setUnitRate(null);
    setRateLoading(true);
    getRampQuote({
      fiatCurrency: country.currency.code,
      cryptoAmount: RATE_PROBE_CRYPTO,
      destinationChain: destination.chainrailsChain,
      countryCode,
    })
      .then((q) => {
        if (!q || cancelled) return;
        if (quoteRate(q) > 0) setUnitRate(quoteRate(q));
        const req = q.paymentChannels?.[0]?.directTransferDetails
          ?.fieldsRequired ?? [];
        setFields(req);
        setFieldValues((prev) => {
          const next = { ...prev };
          for (const fld of req) {
            if (fld.type === "enum" && fld.options?.[0] && !next[fld.key])
              next[fld.key] = fld.options[0].value;
          }
          return next;
        });
      })
      .catch(() => {})
      .finally(() => !cancelled && setRateLoading(false));
    return () => {
      cancelled = true;
    };
  }, [countryCode, country, destination.chainrailsChain]);

  const fiatAmount = Number(amount);
  const estimateUsdc =
    unitRate && fiatAmount > 0 ? fiatAmount / unitRate : null;
  const belowMin =
    !!country && fiatAmount > 0 && fiatAmount < country.currency.minAmount;
  const addressValid = isValidRampAddress(destination.addressKind, address);
  const fieldsComplete = fields.every(
    (fld) => !fld.required || (fieldValues[fld.key]?.trim()?.length ?? 0) > 0
  );
  const emailValid = EMAIL_RE.test(email.trim());
  const canSubmit =
    !!country &&
    fiatAmount > 0 &&
    !!unitRate &&
    !belowMin &&
    addressValid &&
    fieldsComplete &&
    emailValid &&
    !quoting;

  const submit = async () => {
    if (!country || !unitRate) return;
    void saveSavedEmail(email.trim()); // remember it (passed emailValid gate)
    // Convert the fiat typed into the crypto amount ChainRails quotes on.
    const cryptoAmount = Number((fiatAmount / unitRate).toFixed(4));
    setQuoting(true);
    setError(null);
    try {
      const q = await getRampQuote({
        fiatCurrency: country.currency.code,
        cryptoAmount,
        destinationChain: destination.chainrailsChain,
        countryCode,
      });
      if (!q)
        throw new Error("No provider can quote this purchase right now.");
      const created = await createRampOrder({
        type: "on-ramp",
        provider: q.provider,
        fiatCurrency: q.fiatCurrency,
        cryptoAmount: q.cryptoAmount,
        destinationChain: destination.chainrailsChain,
        recipientAddress: address.trim(),
        countryCode,
        // userEmail is a TOP-LEVEL KYC field — PAYCREST 400s without it.
        userEmail: email.trim(),
        fields: { ...fieldValues },
      });
      setOrder(created);
      setPhase(classifyRampStatus(created.status));
      // Order placed — drop the saved draft so a fresh buy starts clean.
      void clearChainrailsRampDraft(destination.chainrailsChain);
      // Remember it on-device so it shows in History and can be reopened instead
      // of creating a duplicate.
      void useRampOrders.getState().track({
        id: String(created.id),
        direction: "onramp",
        chainrailsChain: destination.chainrailsChain,
        chainLabel: destination.label,
        cryptoLabel: `${created.cryptoAmount ?? q.cryptoAmount} ${
          created.cryptoCurrency ?? "USDC"
        }`,
        fiatLabel: `${(
          created.fiatAmount ?? Number(amount) ?? 0
        ).toLocaleString("en-US")} ${created.fiatCurrency ?? country.currency.code}`,
        address: address.trim(),
        widgetUrl: created.widgetUrl,
        status: created.status,
        createdAt: Date.now(),
      });
      // Don't auto-open the checkout — it's jarring. The user taps "Open
      // checkout to pay" themselves, which also starts the status polling.
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't create the order."
      );
    } finally {
      setQuoting(false);
    }
  };

  const orderId = order?.id;

  // Optional immediate check, and make sure the background cadence is running.
  const checkNow = async () => {
    if (orderId == null) return;
    setPolling(true);
    try {
      const data = await getRampOrder(orderId);
      setOrder(data);
      setPhase(classifyRampStatus(data.status));
      if (data.status)
        void useRampOrders.getState().setStatus(String(data.id), data.status);
    } catch {
      /* the poller retries */
    }
  };

  // Poll only after checkout is opened. The shared poller polls immediately,
  // backs off toward 30s, pauses while the app is backgrounded, and stops at a
  // terminal state — keyed on the order id so refreshing it doesn't re-arm it.
  useEffect(() => {
    if (orderId == null || !polling) return;
    const handle = pollRampOrder(orderId, {
      onUpdate: (data) => {
        setOrder(data);
        setPhase(classifyRampStatus(data.status));
        if (data.status)
          void useRampOrders.getState().setStatus(String(data.id), data.status);
      },
      onSettled: (data, settledPhase) => {
        if (data) {
          setOrder(data);
          if (data.status)
            void useRampOrders
              .getState()
              .setStatus(String(data.id), data.status);
        }
        setPhase(settledPhase);
      },
    });
    return () => handle.stop();
  }, [orderId, polling]);

  // Bank-transfer orders have no checkout to open, so nothing else would start
  // the poll — kick it off once an order exists without a checkout URL, so its
  // transfer details load and the status flips when the payment is seen.
  useEffect(() => {
    if (orderId != null && !order?.widgetUrl && !isRampPhaseTerminal(phase))
      setPolling(true);
  }, [orderId, order?.widgetUrl, phase]);

  // Resume an existing order from History — load it and show its status instead
  // of the compose form. Poll on mount since it may already be paid.
  useEffect(() => {
    if (!resumeOrderId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getRampOrder(resumeOrderId);
        if (cancelled) return;
        setOrder(data);
        setPhase(classifyRampStatus(data.status));
        setPolling(true);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof ApiError ? err.message : "Couldn't load this order."
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumeOrderId]);

  // ----- Order created: checkout + live status ----------------------------
  if (order) {
    // Prefer the stored record's labels — a resumed order has an empty form.
    const rec = trackedOrders.find((o) => o.id === String(order.id));
    const crypto = order.cryptoCurrency ?? "USDC";
    const receiveLabel =
      order.cryptoAmount != null
        ? formatToken(order.cryptoAmount, crypto, 2)
        : (rec?.cryptoLabel ?? "—");
    const payLabel =
      order.fiatAmount != null && order.fiatCurrency
        ? `${order.fiatAmount.toLocaleString("en-US")} ${order.fiatCurrency}`
        : (rec?.fiatLabel ?? "—");
    const to = order.recipientAddress ?? rec?.address ?? address;
    const startAgain = () => {
      // Same amount, country, address and refund details; a fresh quote.
      setOrder(null);
      setPhase("pending");
      setPolling(false);
      setError(null);
    };

    if (phase === "expired") {
      return (
        <FlowScreen onBack={onBack}>
          <ExpiredOrder
            steps={STEPS}
            deadline={order.expiresAt ?? null}
            createdAt={order.createdAt ?? null}
            againTitle="Buy again"
            againSub="Same amount, wallet and chain. You'll see today's rate before paying."
            payLabel="You pay"
            payAmount={payLabel}
            receiveLabel="You receive"
            receiveAmount={crypto}
            rateLine="Today's amount shows on the next step"
            primaryLabel="Buy again"
            onPrimary={startAgain}
            quoteRows={[
              { label: "You were paying", value: payLabel },
              { label: "You'd have received", value: receiveLabel },
              ...(to ? [{ label: "To", value: `${short0x(to)} · ${destination.label}` }] : []),
            ]}
            orderId={String(order.id)}
          />
        </FlowScreen>
      );
    }

    if (phase === "completed") {
      return (
        <FlowScreen onBack={onBack}>
          <StepProgress steps={STEPS} current={3} />
          <SuccessCard order={order} destination={destination} />
          <PrimaryButton label="Buy again" onPress={onBack} arrow />
        </FlowScreen>
      );
    }

    const failed = phase === "failed";
    const processing = phase === "processing";
    const transfer = order.transferInstructions;
    const stages = [
      { l: "Order created", d: "Your quote is locked and the order is set up." },
      transfer?.accountIdentifier
        ? { l: "Send the bank transfer", d: "Transfer the exact amount to the account shown." }
        : { l: "Pay in the checkout", d: "Complete the payment in the provider's secure checkout." },
      { l: "Confirming payment", d: `We confirm your payment and send your ${crypto}.` },
      { l: "Received", d: `Delivered to your ${destination.label} wallet.` },
    ];
    return (
      <FlowScreen onBack={onBack}>
        <StepProgress steps={STEPS} current={2} />
        <FlowHeader
          title={
            failed
              ? "Order didn't go through"
              : processing
                ? `Payment received — sending your ${crypto}`
                : `Pay ${payLabel} to finish`
          }
          subtitle={
            failed
              ? "If you didn't pay, nothing was charged. Start a new order."
              : processing
                ? `Delivering to your wallet on ${destination.label}. You can close this.`
                : `You get ${receiveLabel} on ${destination.label} once it clears.`
          }
        />
        {error ? <Notice tone="error">{error}</Notice> : null}

        {!failed && !processing ? (
          transfer?.accountIdentifier ? (
            <Card primary>
              <Text style={kitStyles.cardTitle}>Pay into this account</Text>
              <Text style={kitStyles.small}>Send the exact amount in one transfer from your bank app.</Text>
              {transfer.amountToTransfer ? (
                <CopyRow
                  label="Amount"
                  value={`${transfer.amountToTransfer} ${transfer.currency ?? ""}`.trim()}
                  copyText={transfer.amountToTransfer}
                />
              ) : null}
              <CopyRow
                label="Account number"
                value={transfer.accountIdentifier}
                copyText={transfer.accountIdentifier}
                mono
              />
              <DetailRows
                rows={[
                  ...(transfer.institution ? [{ label: "Bank", value: transfer.institution }] : []),
                  ...(transfer.accountName ? [{ label: "Account name", value: transfer.accountName }] : []),
                ]}
              />
            </Card>
          ) : order.widgetUrl ? (
            <Card primary>
              <Text style={kitStyles.cardTitle}>Pay in the secure checkout</Text>
              <Text style={kitStyles.small}>It opens in your browser. Come back here when you&apos;re done.</Text>
              <PrimaryButton
                label="Open checkout to pay"
                arrow
                onPress={() => {
                  setPolling(true);
                  void Linking.openURL(order.widgetUrl!);
                }}
              />
            </Card>
          ) : (
            <View style={st.checking}>
              <ActivityIndicator color={c.muted} />
              <Text style={kitStyles.small}>Getting your payment details…</Text>
            </View>
          )
        ) : null}

        {polling && !failed && !processing && (transfer?.accountIdentifier || order.widgetUrl) ? (
          <SecondaryButton label="I've sent the funds" onPress={() => void checkNow()} />
        ) : null}

        <Card>
          <DetailRows
            rows={[
              { label: "You pay", value: payLabel },
              { label: "You receive", value: receiveLabel },
              ...(to ? [{ label: "To", value: `${short0x(to)} on ${destination.label}` }] : []),
            ]}
          />
        </Card>

        <Card>
          <Text style={kitStyles.cardTitle}>Progress</Text>
          <ProgressList stages={stages} activeIndex={processing ? 2 : 1} failed={failed} />
          <Text style={st.orderId} selectable>Order #{order.id}</Text>
        </Card>

        {failed ? <SecondaryButton label="Start a new order" onPress={startAgain} /> : null}
      </FlowScreen>
    );
  }

  // ----- Resuming from History: don't flash the form while loading ----------
  if (resumeOrderId) {
    return (
      <FlowScreen onBack={onBack}>
        <View style={st.center}>
          {error ? <Notice tone="error">{error}</Notice> : <ActivityIndicator color={c.muted} />}
          <Text style={kitStyles.small}>Loading order…</Text>
        </View>
      </FlowScreen>
    );
  }

  // ----- Compose: same layout as the Paycrest Buy screen ---------------------
  const popular = countries.filter((co) => PAYCREST_FIAT.includes(co.currency.code as PaycrestFiat));
  const others = countries.filter((co) => !PAYCREST_FIAT.includes(co.currency.code as PaycrestFiat));
  const toOption = (co: RampCountry): CurrencyOption => ({
    value: co.countryCode,
    flag: flagEmoji(co.countryCode),
    country: co.name,
    code: co.currency.code,
    name: co.currency.name,
  });
  // Paycrest-routed corridors ask for a refund bank by code + number + name —
  // show the bank picker with the name check instead of three raw boxes.
  const bankTrio =
    !!country &&
    PAYCREST_FIAT.includes(country.currency.code as PaycrestFiat) &&
    fields.some((fl) => fl.key === "refundInstitution") &&
    fields.some((fl) => fl.key === "refundAccountIdentifier");
  const otherFields = bankTrio
    ? fields.filter((fl) => !["refundInstitution", "refundAccountIdentifier", "refundAccountName"].includes(fl.key))
    : fields;
  const blocker = !country
    ? "Choose a country"
    : !(fiatAmount > 0)
      ? "Enter an amount"
      : !unitRate
        ? rateLoading
          ? "Loading rate…"
          : "No live rate right now"
        : belowMin
          ? "Below the minimum"
          : !addressValid
            ? `Enter your ${destination.label} wallet address`
            : !fieldsComplete
              ? "Fill in the refund account"
              : !emailValid
                ? "Enter your email"
                : null;

  return (
    <FlowScreen onBack={onBack}>
      <FlowHeader title="Buy crypto" subtitle="Pay with local currency, receive USDC in your wallet." />
      <StepProgress steps={STEPS} current={0} />

      <AmountCard
        label="You pay"
        value={amount}
        onChange={setAmount}
        pill={
          <>
            <CurrencyPill
              flag={country ? flagEmoji(country.countryCode) : "🌍"}
              code={country?.currency.code ?? "—"}
              country={country?.name ?? (loading ? "Loading…" : "Choose")}
              onPress={() => setCurrencyOpen(true)}
            />
            <CurrencySheet
              open={currencyOpen}
              onClose={() => setCurrencyOpen(false)}
              title="Pay with"
              value={countryCode}
              popular={popular.map(toOption)}
              others={others.map(toOption)}
              onSelect={(o) => setCountryCode(o.value)}
            />
          </>
        }
      >
        {belowMin && country ? (
          <Text style={st.warn}>
            Minimum is {country.currency.minAmount.toLocaleString()} {country.currency.code}.
          </Text>
        ) : null}
      </AmountCard>

      {!rateLoading && country && !unitRate ? (
        <Text style={st.warn}>
          Couldn&apos;t load a live rate for {destination.label} in {country.currency.code} right now.
        </Text>
      ) : (
        <RateLine
          approximate
          rate={unitRate && country ? { from: "1 USDC", to: `${unitRate.toLocaleString("en-US")} ${country.currency.code}` } : null}
        />
      )}

      <AmountCard
        label="You receive"
        readOnly
        prefix="≈"
        value={estimateUsdc !== null ? estimateUsdc.toLocaleString("en-US", { maximumFractionDigits: 2 }) : ""}
        pill={chainPicker}
      />

      <Card>
        <View style={{ gap: 6 }}>
          <FieldLabel>Receive USDC to</FieldLabel>
          <TextField
            mono
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            placeholder={`Your ${destination.label} wallet address`}
          />
          {address.length > 0 && !addressValid ? (
            <Text style={st.err}>That doesn&apos;t look like a valid {destination.label} address.</Text>
          ) : null}
        </View>

        {fields.length > 0 ? (
          <>
            <View style={st.divider} />
            <View style={{ gap: 2 }}>
              <Text style={st.sectionTitle}>Refund account</Text>
              <Text style={kitStyles.small}>This account will be used for any refunds.</Text>
            </View>
          </>
        ) : null}

        {bankTrio && country ? (
          <BankAccount
            currency={country.currency.code as PaycrestFiat}
            value={{
              institution: fieldValues.refundInstitution ?? "",
              institutionName: refundBankName,
              accountIdentifier: fieldValues.refundAccountIdentifier ?? "",
              accountName: fieldValues.refundAccountName ?? "",
            }}
            onChange={(v) => {
              setRefundBankName(v.institutionName);
              // Only send keys the provider asked for (it rejects others).
              setFieldValues((p) => ({
                ...p,
                refundInstitution: v.institution,
                refundAccountIdentifier: v.accountIdentifier,
                ...(fields.some((fl) => fl.key === "refundAccountName")
                  ? { refundAccountName: v.accountName }
                  : {}),
              }));
            }}
            onLookupChange={() => {}}
            wrongLabel="Not yours?"
          />
        ) : null}

        {otherFields.map((fld) => (
          <View key={fld.key} style={{ gap: 6 }}>
            <FieldLabel>{fld.label}</FieldLabel>
            {fld.type === "enum" ? (
              <Picker
                title={fld.label}
                searchable
                value={fieldValues[fld.key]}
                options={(fld.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
                onChange={(v) => setFieldValues((p) => ({ ...p, [fld.key]: v }))}
              />
            ) : (
              <TextField
                value={fieldValues[fld.key] ?? ""}
                onChangeText={(t) => setFieldValues((p) => ({ ...p, [fld.key]: t }))}
                keyboardType={fld.type === "phone" ? "phone-pad" : "default"}
                placeholder={fld.label}
              />
            )}
          </View>
        ))}

        <View style={{ gap: 6 }}>
          <FieldLabel>Email (for receipts)</FieldLabel>
          <TextField
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="you@example.com"
          />
        </View>
      </Card>

      {estimateUsdc !== null ? (
        <Text style={kitStyles.small}>Estimate · final rate locks when you create the order</Text>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <PrimaryButton
        label={quoting ? "Getting quote…" : (blocker ?? "Continue to payment")}
        disabled={!canSubmit}
        loading={quoting}
        arrow
        onPress={() => void submit()}
      />
    </FlowScreen>
  );
}

function SuccessCard({ order, destination }: { order: RampOrder; destination: RampDestination }) {
  const txUrl = rampTxUrl(destination.chainrailsChain, order.providerTxHash);
  const crypto = order.cryptoCurrency ?? "USDC";
  return (
    <Card style={{ alignItems: "center", overflow: "hidden" }}>
      <Confetti />
      <SuccessCheck />
      <Text style={st.doneAmount}>
        {order.cryptoAmount != null ? formatToken(order.cryptoAmount, crypto, 2) : crypto}
      </Text>
      <Text style={[kitStyles.small, { textAlign: "center" }]}>
        in your {destination.label} wallet
        {order.recipientAddress ? ` ${short0x(order.recipientAddress)}` : ""}
      </Text>
      {txUrl ? <TextLink label="View transaction ↗" onPress={() => void Linking.openURL(txUrl)} /> : null}
      <Text style={st.orderId} selectable>Order #{order.id}</Text>
    </Card>
  );
}

const st = StyleSheet.create({
  center: { alignItems: "center", gap: z(10), paddingVertical: z(48) },
  checking: { flexDirection: "row", alignItems: "center", gap: z(8) },
  divider: { height: z(1), backgroundColor: c.edgeSoft },
  sectionTitle: { color: c.ink, fontSize: zf(15), fontWeight: "600" },
  err: { color: c.danger, fontSize: zf(13) },
  warn: { color: c.warnInk, fontSize: zf(13), lineHeight: z(18) },
  doneAmount: { color: c.ink, fontSize: zf(30), fontWeight: "600", marginTop: z(8) },
  orderId: { color: c.muted, fontSize: zf(12), fontFamily: "Menlo" },
});
