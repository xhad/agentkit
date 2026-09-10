import { z } from "zod";
import { Decimal } from "decimal.js";
import { Address, encodeFunctionData, formatUnits, Hex, parseUnits } from "viem";
import { ActionProvider } from "../actionProvider";
import { EvmWalletProvider } from "../../wallet-providers";
import { CreateAction } from "../actionDecorator";
import { Network } from "../../network";
import {
  SAPIEN_REWARDS_CONTROLLER_ADDRESS,
  SAPIEN_TOKEN_ADDRESS,
  SAPIEN_VAULT_ABI,
  SAPIEN_VAULT_ADDRESS,
  SAPIEN_VAULT_APP_URL,
} from "./constants";
import {
  SapienVaultDepositSchema,
  SapienVaultGetPositionSchema,
  SapienVaultRedeemSchema,
  SapienVaultWithdrawSchema,
} from "./schemas";
import {
  approveSapienIfNeeded,
  isSapienVaultNetwork,
  readSapienShareDecimals,
  readSapienTokenDecimals,
  sapienVaultNetworkError,
} from "./utils";

/**
 * SapienVaultActionProvider is an action provider for the Sapien Vault (vSAPIEN) on Base.
 */
export class SapienVaultActionProvider extends ActionProvider<EvmWalletProvider> {
  /**
   * Constructor for the SapienVaultActionProvider class.
   */
  constructor() {
    super("sapienVault", []);
  }

  /**
   * Deposits SAPIEN into the Sapien Vault, approving the vault only when needed.
   *
   * @param wallet - The wallet instance to execute the transaction.
   * @param args - The input arguments for the action.
   * @returns A success message with transaction details or an error message.
   */
  @CreateAction({
    name: "deposit",
    description: `
This tool deposits SAPIEN into the Sapien Vault on Base mainnet (ERC-4626) and mints vSAPIEN shares.

It takes:
- assets: The amount of SAPIEN to deposit in whole units (e.g. "1", "0.5", "100")
- receiver: Optional address to receive vSAPIEN. Defaults to the connected wallet.

Important notes:
- Only Base mainnet is supported. Do not call this on any other chain.
- Use the exact amount provided. Do not convert units.
- The vault will be approved to spend SAPIEN only if the current allowance is insufficient.
- Newly deposited shares may be subject to a minimum deposit age before they can be withdrawn or transferred.
- App: ${SAPIEN_VAULT_APP_URL}
- Vault (vSAPIEN): ${SAPIEN_VAULT_ADDRESS}
- Underlying SAPIEN: ${SAPIEN_TOKEN_ADDRESS}
`,
    schema: SapienVaultDepositSchema,
  })
  async deposit(
    wallet: EvmWalletProvider,
    args: z.infer<typeof SapienVaultDepositSchema>,
  ): Promise<string> {
    const networkError = sapienVaultNetworkError(wallet);
    if (networkError) {
      return networkError;
    }

    const assets = new Decimal(args.assets);
    if (assets.comparedTo(new Decimal(0.0)) != 1) {
      return "Error: Assets amount must be greater than 0";
    }

    try {
      const owner = wallet.getAddress() as Address;
      const receiver = (args.receiver ?? owner) as Address;

      const decimals = await readSapienTokenDecimals(wallet);
      const atomicAssets = parseUnits(args.assets, decimals);

      const maxDeposit = (await wallet.readContract({
        address: SAPIEN_VAULT_ADDRESS as Hex,
        abi: SAPIEN_VAULT_ABI,
        functionName: "maxDeposit",
        args: [receiver],
      })) as bigint;

      if (atomicAssets > maxDeposit) {
        return (
          `Error: Deposit of ${args.assets} SAPIEN exceeds maxDeposit (${formatUnits(maxDeposit, decimals)} SAPIEN). ` +
          `The vault may be paused.`
        );
      }

      const previewShares = (await wallet.readContract({
        address: SAPIEN_VAULT_ADDRESS as Hex,
        abi: SAPIEN_VAULT_ABI,
        functionName: "previewDeposit",
        args: [atomicAssets],
      })) as bigint;

      if (previewShares === 0n) {
        return "Error: previewDeposit returned 0 shares. Wait and retry rather than depositing.";
      }

      const approvalResult = await approveSapienIfNeeded(wallet, owner, atomicAssets);
      if (approvalResult.startsWith("Error")) {
        return `Error approving Sapien Vault as spender: ${approvalResult}`;
      }

      const data = encodeFunctionData({
        abi: SAPIEN_VAULT_ABI,
        functionName: "deposit",
        args: [atomicAssets, receiver],
      });

      const txHash = await wallet.sendTransaction({
        to: SAPIEN_VAULT_ADDRESS as Hex,
        data,
      });

      const receipt = await wallet.waitForTransactionReceipt(txHash);

      return (
        `Deposited ${args.assets} SAPIEN to Sapien Vault ${SAPIEN_VAULT_ADDRESS} ` +
        `for ${receiver} with transaction hash: ${txHash}\n` +
        `Transaction receipt: ${JSON.stringify(receipt)}\n` +
        `App: ${SAPIEN_VAULT_APP_URL}`
      );
    } catch (error) {
      return `Error depositing to Sapien Vault: ${error}`;
    }
  }

  /**
   * Withdraws SAPIEN from the Sapien Vault by asset amount (ERC-4626 withdraw).
   *
   * @param wallet - The wallet instance to execute the transaction.
   * @param args - The input arguments for the action.
   * @returns A success message with transaction details or an error message.
   */
  @CreateAction({
    name: "withdraw",
    description: `
This tool withdraws SAPIEN from the Sapien Vault on Base mainnet by asset amount (ERC-4626 withdraw).

It takes:
- assets: The amount of SAPIEN to withdraw in whole units (e.g. "1", "0.5")
- receiver: Optional address to receive SAPIEN. Defaults to the connected wallet.

Use withdraw when the user specifies an amount of SAPIEN. Use redeem when they specify vSAPIEN shares.

Important notes:
- Only Base mainnet is supported.
- Withdrawals are limited by maxWithdraw (matured, unlocked shares). Fresh deposits may still be aging, and locked validator stake cannot be withdrawn until the engine unlocks it.
- App: ${SAPIEN_VAULT_APP_URL}
`,
    schema: SapienVaultWithdrawSchema,
  })
  async withdraw(
    wallet: EvmWalletProvider,
    args: z.infer<typeof SapienVaultWithdrawSchema>,
  ): Promise<string> {
    const networkError = sapienVaultNetworkError(wallet);
    if (networkError) {
      return networkError;
    }

    const assets = new Decimal(args.assets);
    if (assets.comparedTo(new Decimal(0.0)) != 1) {
      return "Error: Assets amount must be greater than 0";
    }

    try {
      const owner = wallet.getAddress() as Address;
      const receiver = (args.receiver ?? owner) as Address;
      const decimals = await readSapienTokenDecimals(wallet);
      const atomicAssets = parseUnits(args.assets, decimals);

      const maxWithdraw = (await wallet.readContract({
        address: SAPIEN_VAULT_ADDRESS as Hex,
        abi: SAPIEN_VAULT_ABI,
        functionName: "maxWithdraw",
        args: [owner],
      })) as bigint;

      if (atomicAssets > maxWithdraw) {
        return (
          `Error: Withdraw of ${args.assets} SAPIEN exceeds maxWithdraw ` +
          `(${formatUnits(maxWithdraw, decimals)} SAPIEN). ` +
          `Shares may still be aging (minDepositAge) or locked as validator stake.`
        );
      }

      const data = encodeFunctionData({
        abi: SAPIEN_VAULT_ABI,
        functionName: "withdraw",
        args: [atomicAssets, receiver, owner],
      });

      const txHash = await wallet.sendTransaction({
        to: SAPIEN_VAULT_ADDRESS as Hex,
        data,
      });

      const receipt = await wallet.waitForTransactionReceipt(txHash);

      return (
        `Withdrawn ${args.assets} SAPIEN from Sapien Vault ${SAPIEN_VAULT_ADDRESS} ` +
        `to ${receiver} with transaction hash: ${txHash}\n` +
        `Transaction receipt: ${JSON.stringify(receipt)}\n` +
        `App: ${SAPIEN_VAULT_APP_URL}`
      );
    } catch (error) {
      return `Error withdrawing from Sapien Vault: ${error}`;
    }
  }

  /**
   * Redeems vSAPIEN shares from the Sapien Vault (ERC-4626 redeem).
   *
   * @param wallet - The wallet instance to execute the transaction.
   * @param args - The input arguments for the action.
   * @returns A success message with transaction details or an error message.
   */
  @CreateAction({
    name: "redeem",
    description: `
This tool redeems vSAPIEN shares from the Sapien Vault on Base mainnet (ERC-4626 redeem) for SAPIEN.

It takes:
- shares: The amount of vSAPIEN to redeem in whole units (e.g. "1", "0.5")
- receiver: Optional address to receive SAPIEN. Defaults to the connected wallet.

Use redeem when the user specifies an amount of vSAPIEN shares. Use withdraw when they specify SAPIEN assets.

Important notes:
- Only Base mainnet is supported.
- vSAPIEN uses the vault's share decimals (underlying decimals plus an internal offset). Pass whole share units; do not convert.
- Redemptions are limited by maxRedeem (matured, unlocked shares).
- App: ${SAPIEN_VAULT_APP_URL}
`,
    schema: SapienVaultRedeemSchema,
  })
  async redeem(
    wallet: EvmWalletProvider,
    args: z.infer<typeof SapienVaultRedeemSchema>,
  ): Promise<string> {
    const networkError = sapienVaultNetworkError(wallet);
    if (networkError) {
      return networkError;
    }

    const shares = new Decimal(args.shares);
    if (shares.comparedTo(new Decimal(0.0)) != 1) {
      return "Error: Shares amount must be greater than 0";
    }

    try {
      const owner = wallet.getAddress() as Address;
      const receiver = (args.receiver ?? owner) as Address;
      const shareDecimals = await readSapienShareDecimals(wallet);
      const atomicShares = parseUnits(args.shares, shareDecimals);

      const maxRedeem = (await wallet.readContract({
        address: SAPIEN_VAULT_ADDRESS as Hex,
        abi: SAPIEN_VAULT_ABI,
        functionName: "maxRedeem",
        args: [owner],
      })) as bigint;

      if (atomicShares > maxRedeem) {
        return (
          `Error: Redeem of ${args.shares} vSAPIEN exceeds maxRedeem ` +
          `(${formatUnits(maxRedeem, shareDecimals)} vSAPIEN). ` +
          `Shares may still be aging (minDepositAge) or locked as validator stake.`
        );
      }

      const data = encodeFunctionData({
        abi: SAPIEN_VAULT_ABI,
        functionName: "redeem",
        args: [atomicShares, receiver, owner],
      });

      const txHash = await wallet.sendTransaction({
        to: SAPIEN_VAULT_ADDRESS as Hex,
        data,
      });

      const receipt = await wallet.waitForTransactionReceipt(txHash);

      return (
        `Redeemed ${args.shares} vSAPIEN from Sapien Vault ${SAPIEN_VAULT_ADDRESS} ` +
        `to ${receiver} with transaction hash: ${txHash}\n` +
        `Transaction receipt: ${JSON.stringify(receipt)}\n` +
        `App: ${SAPIEN_VAULT_APP_URL}`
      );
    } catch (error) {
      return `Error redeeming from Sapien Vault: ${error}`;
    }
  }

  /**
   * Reads a user's Sapien Vault shares and asset TVL.
   *
   * @param wallet - The wallet instance used for contract reads.
   * @param args - Optional address to inspect. Defaults to the connected wallet.
   * @returns Share and asset balances, or an error message.
   */
  @CreateAction({
    name: "get_position",
    description: `
This tool reads a Sapien Vault position on Base mainnet: vSAPIEN shares and the SAPIEN asset value (user TVL).

It takes:
- address: Optional address to inspect. Defaults to the connected wallet.

User TVL is convertToAssets(balanceOf(address)) only. Do not include RewardsController (${SAPIEN_REWARDS_CONTROLLER_ADDRESS}) inventory in user TVL — that contract holds the unstreamed reward budget, not a user deposit.

Also reports maxWithdraw / maxRedeem (matured, unlocked amounts that can exit now).

Only Base mainnet is supported. App: ${SAPIEN_VAULT_APP_URL}
`,
    schema: SapienVaultGetPositionSchema,
  })
  async getPosition(
    wallet: EvmWalletProvider,
    args: z.infer<typeof SapienVaultGetPositionSchema>,
  ): Promise<string> {
    const networkError = sapienVaultNetworkError(wallet);
    if (networkError) {
      return networkError;
    }

    try {
      const owner = (args.address ?? wallet.getAddress()) as Address;
      const [tokenDecimals, shareDecimals] = await Promise.all([
        readSapienTokenDecimals(wallet),
        readSapienShareDecimals(wallet),
      ]);

      const [userShares, maxWithdraw, maxRedeem, rewardsControllerShares] = await Promise.all([
        wallet.readContract({
          address: SAPIEN_VAULT_ADDRESS as Hex,
          abi: SAPIEN_VAULT_ABI,
          functionName: "balanceOf",
          args: [owner],
        }) as Promise<bigint>,
        wallet.readContract({
          address: SAPIEN_VAULT_ADDRESS as Hex,
          abi: SAPIEN_VAULT_ABI,
          functionName: "maxWithdraw",
          args: [owner],
        }) as Promise<bigint>,
        wallet.readContract({
          address: SAPIEN_VAULT_ADDRESS as Hex,
          abi: SAPIEN_VAULT_ABI,
          functionName: "maxRedeem",
          args: [owner],
        }) as Promise<bigint>,
        wallet.readContract({
          address: SAPIEN_VAULT_ADDRESS as Hex,
          abi: SAPIEN_VAULT_ABI,
          functionName: "balanceOf",
          args: [SAPIEN_REWARDS_CONTROLLER_ADDRESS as Address],
        }) as Promise<bigint>,
      ]);

      const [userAssets, rewardsControllerAssets] = await Promise.all([
        wallet.readContract({
          address: SAPIEN_VAULT_ADDRESS as Hex,
          abi: SAPIEN_VAULT_ABI,
          functionName: "convertToAssets",
          args: [userShares],
        }) as Promise<bigint>,
        wallet.readContract({
          address: SAPIEN_VAULT_ADDRESS as Hex,
          abi: SAPIEN_VAULT_ABI,
          functionName: "convertToAssets",
          args: [rewardsControllerShares],
        }) as Promise<bigint>,
      ]);

      return [
        `Sapien Vault position for ${owner} on Base mainnet:`,
        `- vSAPIEN shares: ${formatUnits(userShares, shareDecimals)} (${userShares} atomic)`,
        `- SAPIEN assets (user TVL): ${formatUnits(userAssets, tokenDecimals)} (${userAssets} atomic)`,
        `- maxWithdraw: ${formatUnits(maxWithdraw, tokenDecimals)} SAPIEN`,
        `- maxRedeem: ${formatUnits(maxRedeem, shareDecimals)} vSAPIEN`,
        ``,
        `User TVL is convertToAssets(shares) only and excludes RewardsController ` +
          `${SAPIEN_REWARDS_CONTROLLER_ADDRESS} inventory ` +
          `(${formatUnits(rewardsControllerAssets, tokenDecimals)} SAPIEN-equivalent; not a user deposit).`,
        `Vault: ${SAPIEN_VAULT_ADDRESS}`,
        `Underlying SAPIEN: ${SAPIEN_TOKEN_ADDRESS}`,
        `App: ${SAPIEN_VAULT_APP_URL}`,
      ].join("\n");
    } catch (error) {
      return `Error reading Sapien Vault position: ${error}`;
    }
  }

  /**
   * Checks if the Sapien Vault action provider supports the given network.
   *
   * @param network - The network to check.
   * @returns True only for Base mainnet.
   */
  supportsNetwork = (network: Network) => isSapienVaultNetwork(network);
}

/**
 * Creates a new SapienVaultActionProvider instance.
 *
 * @returns A new SapienVaultActionProvider instance.
 */
export const sapienVaultActionProvider = () => new SapienVaultActionProvider();
