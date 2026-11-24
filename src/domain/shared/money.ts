import DecimalBase from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/**
 * Decimal isolado do global, com precisão explícita (o padrão do decimal.js é 20 dígitos).
 * 40 dígitos folgam muito sobre NUMERIC(19,2) (17 inteiros + 2 decimais).
 */
const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_EVEN });
type Decimal = DecimalBase;

/** DTO de dinheiro nos contratos: string decimal (nunca `number`) e moeda ISO-4217. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
/** Cabe em NUMERIC(19,2): 17 dígitos inteiros + 2 decimais. */
const MAX_INTEGER_DIGITS = 17;
const MAX_ABSOLUTE = new Decimal('9'.repeat(MAX_INTEGER_DIGITS)).plus('0.99');

/** 0 a 17 dígitos inteiros, com 0 a 2 decimais. Sem sinal, sem espaço, sem notação científica. */
const AMOUNT_PATTERN = new RegExp(`^\\d{1,${MAX_INTEGER_DIGITS}}(\\.\\d{1,${SCALE}})?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function assertValidCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(
      `Moeda inválida: esperado código ISO-4217 de 3 letras maiúsculas, recebido ${JSON.stringify(currency)}`,
    );
  }
}

/**
 * Valor monetário imutável, com escala fixa de 2 casas.
 *
 * - Entrada (`from`): string decimal não negativa. Aceita 0, 1 ou 2 casas e normaliza para 2
 *   (`"25"` e `"25.5"` viram `"25.00"` e `"25.50"`). Rejeita `NaN`, `Infinity`, notação científica,
 *   string vazia, sinal, espaços, mais de 2 casas e mais de 17 dígitos inteiros.
 * - Resultados de `subtract` e `negate` podem ser negativos (útil para cálculo); apenas `from`
 *   rejeita negativos, porque ele modela contratos de entrada.
 * - Nunca usa `number`: a aritmética é toda de `decimal.js`.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Dinheiro deve ser um objeto { amount, currency }');
    }
    assertValidCurrency(props.currency);
    const { amount } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(
        `amount deve ser uma string decimal (ex.: "25.00"), recebido ${typeof amount}`,
      );
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount inválido: ${JSON.stringify(amount)}. Esperado decimal não negativo com até ${SCALE} casas e até ${MAX_INTEGER_DIGITS} dígitos inteiros`,
      );
    }
    return new Money(new Decimal(amount), props.currency);
  }

  static zero(currency: string): Money {
    assertValidCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  /** Resultado de aritmética: pode ser negativo, mas nunca excede a magnitude do schema. */
  private static ofResult(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(MAX_ABSOLUTE)) {
      throw new InvalidMoneyError('Valor excede o máximo representável (NUMERIC(19,2))');
    }
    // Operandos já têm escala 2, então soma e subtração não produzem mais casas. Normaliza mesmo assim.
    return new Money(value.toDecimalPlaces(SCALE, DecimalBase.ROUND_HALF_EVEN), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofResult(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofResult(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.ofResult(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  /** Moedas diferentes nunca são iguais (não lança): a comparação de igualdade é total. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** String decimal com exatamente 2 casas. */
  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Operação entre moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}
