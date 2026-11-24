import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/shared/errors';
import { Money } from '../../../src/domain/shared/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from: entradas válidas', () => {
  test.each([
    ['25.00', '25.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['0.00', '0.00'],
    ['0.01', '0.01'],
    ['007.10', '7.10'],
    ['99999999999999999.99', '99999999999999999.99'],
  ])('normaliza %p para a escala 2 (%p)', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  test('preserva todos os dígitos de valores grandes (um float de 64 bits corromperia)', () => {
    expect(brl('12345678901234567.89').amount).toBe('12345678901234567.89');
  });

  test('toJSON e toString usam string decimal com a moeda', () => {
    const money = brl('25');
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify({ money })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(money.toString()).toBe('25.00 BRL');
  });
});

describe('Money.from: entradas inválidas', () => {
  test.each([
    ['string vazia', ''],
    ['espaço', ' '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica maiúscula', '1E3'],
    ['mais de 2 casas', '25.001'],
    ['mais de 2 casas, zeros', '25.000'],
    ['negativo', '-1.00'],
    ['zero negativo', '-0.00'],
    ['sinal positivo', '+1.00'],
    ['espaço à esquerda', ' 1.00'],
    ['espaço à direita', '1.00 '],
    ['vírgula decimal', '25,00'],
    ['separador de milhar', '1,000.00'],
    ['ponto sem decimais', '25.'],
    ['ponto sem inteiros', '.50'],
    ['hexadecimal', '0x10'],
    ['texto', 'abc'],
    ['18 dígitos inteiros (excede NUMERIC(19,2))', '100000000000000000.00'],
  ])('rejeita %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (inclui number)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: undefined as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(['', 'br', 'BRLL', 'brl', 'Brl', 'B1L', ' BRL'])('rejeita moeda %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('rejeita moeda ausente ou de tipo errado', () => {
    expect(() => Money.from({ amount: '1.00' } as never)).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 123 } as never)).toThrow(InvalidMoneyError);
  });

  test('rejeita props nulo ou que não é objeto', () => {
    expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
    expect(() => Money.from('25.00' as never)).toThrow(InvalidMoneyError);
  });
});

describe('Money: aritmética exata', () => {
  test('0.1 + 0.2 é exatamente 0.30 (o clássico que quebra em float)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('soma com vai-um e subtração com empréstimo', () => {
    expect(brl('67.89').add(brl('0.11')).amount).toBe('68.00');
    expect(brl('68.00').subtract(brl('0.01')).amount).toBe('67.99');
  });

  test('soma de 1000 parcelas de 0.01 dá 10.00', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('add e subtract não alteram os operandos (imutabilidade)', () => {
    const a = brl('10.00');
    const b = brl('3.00');
    const sum = a.add(b);
    const diff = a.subtract(b);
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('3.00');
    expect(sum).not.toBe(a);
    expect(diff).not.toBe(a);
  });

  test('a instância é congelada', () => {
    const money = brl('1.00');
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });

  test('subtract pode ficar negativo (cálculo), e negate inverte o sinal', () => {
    const negative = brl('1.00').subtract(brl('3.50'));
    expect(negative.amount).toBe('-2.50');
    expect(negative.isNegative()).toBe(true);
    expect(negative.negate().amount).toBe('2.50');
    expect(negative.negate().isPositive()).toBe(true);
  });

  test('negate de zero é zero', () => {
    const zero = Money.zero('BRL').negate();
    expect(zero.isZero()).toBe(true);
    expect(zero.isNegative()).toBe(false);
    expect(zero.amount).toBe('0.00');
  });

  test('estourar a magnitude do schema lança erro, em vez de gerar um valor que o banco recusaria', () => {
    const max = brl('99999999999999999.99');
    expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => max.negate().subtract(brl('0.01'))).toThrow(InvalidMoneyError);
  });
});

describe('Money: comparações', () => {
  test('isZero, isPositive, isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isZero()).toBe(false);
    expect(brl('0.01').isNegative()).toBe(false);
  });

  test('isLessThan e isGreaterThan', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.01').isGreaterThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isGreaterThan(brl('80.00'))).toBe(false);
  });

  test('equals compara valor e moeda, e "25" equivale a "25.00"', () => {
    expect(brl('25').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(Money.from({ amount: '25.00', currency: 'USD' }))).toBe(false);
  });
});

describe('Money: conflito de moeda', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('add, subtract e comparações entre moedas diferentes lançam erro de domínio', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isGreaterThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('o resultado mantém a moeda dos operandos', () => {
    expect(brl('1.00').add(brl('2.00')).currency).toBe('BRL');
    expect(Money.zero('USD').currency).toBe('USD');
  });

  test('zero rejeita moeda inválida', () => {
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });
});
