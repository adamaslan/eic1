export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WrongPassphraseError extends AppError {}
export class VaultNotFoundError extends AppError {}
export class VaultAlreadyExistsError extends AppError {}
export class VaultLockedError extends AppError {}
export class VaultCorruptError extends AppError {}
