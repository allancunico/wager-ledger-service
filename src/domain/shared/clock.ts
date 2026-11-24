/**
 * Relógio injetável. O domínio nunca chama `new Date()` diretamente: recebe o instante como
 * parâmetro, e a camada de aplicação obtém esse instante de um `Clock`. Assim TTL e backoff ficam
 * determinísticos nos testes.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Relógio controlável, para testes. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
