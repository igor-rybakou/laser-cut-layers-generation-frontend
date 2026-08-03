export type Unsubscribe = () => void;

export class Store<T> {
  private value: T;
  private subs = new Set<(v: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    for (const fn of this.subs) fn(this.value);
  }

  update(fn: (v: T) => T): void {
    this.set(fn(this.value));
  }

  subscribe(fn: (v: T) => void, immediate = true): Unsubscribe {
    this.subs.add(fn);
    if (immediate) fn(this.value);
    return () => this.subs.delete(fn);
  }
}

export function store<T>(initial: T): Store<T> {
  return new Store(initial);
}
