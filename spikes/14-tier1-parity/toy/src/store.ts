export interface Item {
  id: number;
  name: string;
  qty: number;
}

export class ItemStore {
  private items = new Map<number, Item>();
  private next = 1;

  add(name: string, qty: number): Item {
    const item = { id: this.next++, name, qty };
    this.items.set(item.id, item);
    return item;
  }

  get(id: number): Item | undefined {
    return this.items.get(id);
  }

  remove(id: number): boolean {
    return this.items.delete(id);
  }

  list(): Item[] {
    return [...this.items.values()];
  }
}

// Module-level counter: shared by every importer in the same module graph.
let created = 0;
export function storesCreated(): number {
  return created;
}
export function makeStore(): ItemStore {
  created++;
  return new ItemStore();
}
