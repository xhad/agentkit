# Sapien Vault Action Provider

This directory contains the **SapienVaultActionProvider**, which lets AgentKit agents deposit SAPIEN, withdraw or redeem vSAPIEN, and read position state on the Sapien Vault — an ERC-4626 vault on Base mainnet.

App: [https://vault.sapien.io](https://vault.sapien.io)

## Directory Structure

```
sapienVault/
├── sapienVaultActionProvider.ts         # Main provider
├── sapienVaultActionProvider.test.ts    # Unit tests
├── constants.ts                         # Base mainnet addresses and vault ABI
├── schemas.ts                           # Zod action schemas
├── utils.ts                             # Network guard and approve-if-needed
├── index.ts                             # Exports
└── README.md                            # This file
```

## Contracts (Base mainnet, EIP-55)

| Role | Address |
| --- | --- |
| Vault / vSAPIEN (ERC-4626) | `0x60Bf63729f688287a450299962b36Cef0aFfaa42` |
| Underlying SAPIEN | `0xC729777d0470F30612B1564Fd96E8Dd26f5814E3` |
| RewardsController (exclude from user TVL) | `0x55Ce7717Bc8c8F1b59AdB9e0CE7abc332391BF18` |

## Actions

- `deposit`: Approve SAPIEN for the vault if allowance is insufficient, then call ERC-4626 `deposit`
- `withdraw`: Redeem SAPIEN by **asset** amount (`withdraw`)
- `redeem`: Redeem SAPIEN by **share** amount (`redeem`)
- `get_position`: Read vSAPIEN shares, SAPIEN asset value (user TVL), `maxWithdraw`, and `maxRedeem`

### User TVL

`get_position` reports user TVL as `convertToAssets(balanceOf(user))` only. The RewardsController holds unstreamed reward inventory; that balance is **not** part of a user's position and is called out separately so agents do not add it to TVL.

## Network Support

**Base mainnet only** (`networkId` `base-mainnet` or `chainId` `8453`).

`supportsNetwork` returns `false` on every other chain. Each action also returns a clear error if the connected wallet is not on Base mainnet (including Base Sepolia).

## Adding New Actions

1. Define the schema in `schemas.ts`
2. Implement the action in `sapienVaultActionProvider.ts`
3. Add tests in `sapienVaultActionProvider.test.ts`

## Notes

- Fresh deposits may be subject to `minDepositAge` before they can be withdrawn or transferred. Locked validator stake cannot be withdrawn until the engine unlocks it. Actions consult `maxDeposit` / `maxWithdraw` / `maxRedeem`.
- vSAPIEN share decimals are the underlying decimals plus an internal ERC-4626 offset. `redeem` uses the vault's `decimals()`.
- For protocol design, see the [SapienVault docs](https://github.com/Sapien-io/sapien-contracts/blob/main/docs/SapienVault.md).
