"use client";

import { useEffect, useState } from "react";

export type FinancialInputs = {
  currentSavings: number;
  monthlySavings: number;
  expectedReturn: number;
  targetAmount: number;
  timeHorizon: number;
};

export type InputFormProps = {
  /** Called with validated numeric values when the form is submitted. */
  onSubmit: (values: FinancialInputs) => void;
  /** Optional initial values to pre-populate the form (e.g. loaded from persistence). */
  initialValues?: Partial<FinancialInputs>;
};

type FormState = {
  currentSavings: string;
  monthlySavings: string;
  expectedReturn: string;
  targetAmount: string;
  timeHorizon: string;
};

type FormErrors = Partial<Record<keyof FormState, string>>;

function parseFiniteNumber(raw: string): number | null {
  // Treat empty/whitespace as invalid.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export default function InputForm({ onSubmit, initialValues }: InputFormProps) {
  const [form, setForm] = useState<FormState>({
    currentSavings: "",
    monthlySavings: "",
    expectedReturn: "",
    targetAmount: "",
    timeHorizon: "",
  });

  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (!initialValues) return;

    setForm((prev) => ({
      ...prev,
      currentSavings:
        initialValues.currentSavings === undefined
          ? prev.currentSavings
          : String(initialValues.currentSavings),
      monthlySavings:
        initialValues.monthlySavings === undefined
          ? prev.monthlySavings
          : String(initialValues.monthlySavings),
      expectedReturn:
        initialValues.expectedReturn === undefined
          ? prev.expectedReturn
          : String(initialValues.expectedReturn),
      targetAmount:
        initialValues.targetAmount === undefined
          ? prev.targetAmount
          : String(initialValues.targetAmount),
      timeHorizon:
        initialValues.timeHorizon === undefined
          ? prev.timeHorizon
          : String(initialValues.timeHorizon),
    }));
  }, [initialValues]);

  function updateField(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function validate(): { values: FinancialInputs | null; errors: FormErrors } {
    const nextErrors: FormErrors = {};

    const currentSavings = parseFiniteNumber(form.currentSavings);
    const monthlySavings = parseFiniteNumber(form.monthlySavings);
    // User enters a percentage (e.g. 10 for 10%).
    // Conversion to decimal is handled by the dashboard before calling engine functions.
    const expectedReturnPercent = parseFiniteNumber(form.expectedReturn);
    const targetAmount = parseFiniteNumber(form.targetAmount);
    const timeHorizon = parseFiniteNumber(form.timeHorizon);

    if (currentSavings === null) nextErrors.currentSavings = "Enter a valid number.";
    if (monthlySavings === null) nextErrors.monthlySavings = "Enter a valid number.";
    if (expectedReturnPercent === null) nextErrors.expectedReturn = "Enter a valid number.";
    if (targetAmount === null) nextErrors.targetAmount = "Enter a valid number.";
    if (timeHorizon === null) nextErrors.timeHorizon = "Enter a valid number.";

    if (timeHorizon !== null && timeHorizon < 0) {
      nextErrors.timeHorizon = "Must be 0 or greater.";
    }

    // Expected return is entered as a percentage (e.g. 10 for 10%). Enforce >= 0.
    if (expectedReturnPercent !== null && expectedReturnPercent < 0) {
      nextErrors.expectedReturn = "Must be 0 or greater.";
    }

    const hasErrors = Object.keys(nextErrors).length > 0;
    if (hasErrors) {
      return { values: null, errors: nextErrors };
    }

    return {
      values: {
        currentSavings: currentSavings!,
        monthlySavings: monthlySavings!,
        expectedReturn: expectedReturnPercent!,
        targetAmount: targetAmount!,
        timeHorizon: timeHorizon!,
      },
      errors: {},
    };
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const result = validate();
    setErrors(result.errors);

    if (result.values) {
      onSubmit(result.values);
    }
  }

  const inputClassName =
    "mt-1 w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-foreground outline-none focus:border-foreground/40";

  const errorClassName = "mt-1 text-sm text-foreground/70";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="currentSavings" className="block text-sm font-medium">
          Current savings
        </label>
        <input
          id="currentSavings"
          name="currentSavings"
          type="number"
          inputMode="decimal"
          step="any"
          value={form.currentSavings}
          onChange={(e) => updateField("currentSavings", e.target.value)}
          className={inputClassName}
        />
        {errors.currentSavings ? <p className={errorClassName}>{errors.currentSavings}</p> : null}
      </div>

      <div>
        <label htmlFor="monthlySavings" className="block text-sm font-medium">
          Monthly savings
        </label>
        <input
          id="monthlySavings"
          name="monthlySavings"
          type="number"
          inputMode="decimal"
          step="any"
          value={form.monthlySavings}
          onChange={(e) => updateField("monthlySavings", e.target.value)}
          className={inputClassName}
        />
        {errors.monthlySavings ? <p className={errorClassName}>{errors.monthlySavings}</p> : null}
      </div>

      <div>
        <label htmlFor="expectedReturn" className="block text-sm font-medium">
          Expected Annual Return (%)
        </label>
        <input
          id="expectedReturn"
          name="expectedReturn"
          type="number"
          inputMode="decimal"
          step="any"
          value={form.expectedReturn}
          onChange={(e) => updateField("expectedReturn", e.target.value)}
          className={inputClassName}
        />
        {errors.expectedReturn ? <p className={errorClassName}>{errors.expectedReturn}</p> : null}
      </div>

      <div>
        <label htmlFor="targetAmount" className="block text-sm font-medium">
          Target amount
        </label>
        <input
          id="targetAmount"
          name="targetAmount"
          type="number"
          inputMode="decimal"
          step="any"
          value={form.targetAmount}
          onChange={(e) => updateField("targetAmount", e.target.value)}
          className={inputClassName}
        />
        {errors.targetAmount ? <p className={errorClassName}>{errors.targetAmount}</p> : null}
      </div>

      <div>
        <label htmlFor="timeHorizon" className="block text-sm font-medium">
          Time horizon (years)
        </label>
        <input
          id="timeHorizon"
          name="timeHorizon"
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          value={form.timeHorizon}
          onChange={(e) => updateField("timeHorizon", e.target.value)}
          className={inputClassName}
        />
        {errors.timeHorizon ? <p className={errorClassName}>{errors.timeHorizon}</p> : null}
      </div>

      <button
        type="submit"
        className="rounded-md border border-foreground/20 bg-background px-4 py-2 text-sm font-medium text-foreground hover:border-foreground/40"
      >
        Calculate
      </button>
    </form>
  );
}
