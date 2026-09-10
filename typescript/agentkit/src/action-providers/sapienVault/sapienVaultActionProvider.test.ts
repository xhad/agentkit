import { encodeFunctionData, parseUnits } from "viem";
import { EvmWalletProvider } from "../../wallet-providers";
import { approve } from "../../utils";
import { Network } from "../../network";
import { SapienVaultActionProvider } from "./sapienVaultActionProvider";
import {
  SAPIEN_REWARDS_CONTROLLER_ADDRESS,
  SAPIEN_TOKEN_ADDRESS,
  SAPIEN_VAULT_ABI,
  SAPIEN_VAULT_ADDRESS,
} from "./constants";
import {
  SapienVaultDepositSchema,
  SapienVaultGetPositionSchema,
  SapienVaultRedeemSchema,
  SapienVaultWithdrawSchema,
} from "./schemas";

const MOCK_OWNER = "0x9876543210987654321098765432109876543210";
const MOCK_RECEIVER = "0x1111111111111111111111111111111111111111";
const MOCK_TX_HASH = "0xabcdef1234567890";
const MOCK_RECEIPT = { status: 1, blockNumber: 1234567 };
const MOCK_TOKEN_DECIMALS = 18;
const MOCK_SHARE_DECIMALS = 21;
const MOCK_WHOLE_ASSETS = "1.0";
const MOCK_WHOLE_SHARES = "1.0";
const MOCK_USER_SHARES = parseUnits("1.5", MOCK_SHARE_DECIMALS);
const MOCK_USER_ASSETS = parseUnits("1.52", MOCK_TOKEN_DECIMALS);
const MOCK_RC_SHARES = parseUnits("1000", MOCK_SHARE_DECIMALS);
const MOCK_RC_ASSETS = parseUnits("1010", MOCK_TOKEN_DECIMALS);
const MOCK_MAX_DEPOSIT = parseUnits("1000000", MOCK_TOKEN_DECIMALS);
const MOCK_PREVIEW_SHARES = parseUnits("0.99", MOCK_SHARE_DECIMALS);
const MOCK_MAX_WITHDRAW = parseUnits("10", MOCK_TOKEN_DECIMALS);
const MOCK_MAX_REDEEM = parseUnits("10", MOCK_SHARE_DECIMALS);

jest.mock("../../utils");
const mockApprove = approve as jest.MockedFunction<typeof approve>;

describe("SapienVault Action Provider", () => {
  const actionProvider = new SapienVaultActionProvider();
  let mockWallet: jest.Mocked<EvmWalletProvider>;

  const mockReadContract = jest.fn();

  beforeEach(() => {
    mockReadContract.mockImplementation(({ address, functionName, args }) => {
      if (functionName === "decimals") {
        return address === SAPIEN_VAULT_ADDRESS ? MOCK_SHARE_DECIMALS : MOCK_TOKEN_DECIMALS;
      }
      if (functionName === "allowance") {
        return 0n;
      }
      if (functionName === "maxDeposit") {
        return MOCK_MAX_DEPOSIT;
      }
      if (functionName === "previewDeposit") {
        return MOCK_PREVIEW_SHARES;
      }
      if (functionName === "maxWithdraw") {
        return MOCK_MAX_WITHDRAW;
      }
      if (functionName === "maxRedeem") {
        return MOCK_MAX_REDEEM;
      }
      if (functionName === "balanceOf") {
        const account = (args?.[0] as string)?.toLowerCase();
        if (account === SAPIEN_REWARDS_CONTROLLER_ADDRESS.toLowerCase()) {
          return MOCK_RC_SHARES;
        }
        return MOCK_USER_SHARES;
      }
      if (functionName === "convertToAssets") {
        const shares = args?.[0] as bigint;
        if (shares === MOCK_RC_SHARES) {
          return MOCK_RC_ASSETS;
        }
        return MOCK_USER_ASSETS;
      }
      throw new Error(`Unexpected readContract call: ${functionName}`);
    });

    mockWallet = {
      getAddress: jest.fn().mockReturnValue(MOCK_OWNER),
      getNetwork: jest.fn().mockReturnValue({
        protocolFamily: "evm",
        networkId: "base-mainnet",
        chainId: "8453",
      } as Network),
      sendTransaction: jest.fn().mockResolvedValue(MOCK_TX_HASH as `0x${string}`),
      waitForTransactionReceipt: jest.fn().mockResolvedValue(MOCK_RECEIPT),
      readContract: mockReadContract,
    } as unknown as jest.Mocked<EvmWalletProvider>;

    mockApprove.mockClear();
    mockApprove.mockResolvedValue("Approval successful");
  });

  describe("schemas", () => {
    it("should parse a valid deposit", () => {
      const result = SapienVaultDepositSchema.safeParse({ assets: "1.5" });
      expect(result.success).toBe(true);
    });

    it("should reject a non-numeric deposit", () => {
      expect(SapienVaultDepositSchema.safeParse({ assets: "abc" }).success).toBe(false);
    });

    it("should parse a valid withdraw and redeem", () => {
      expect(SapienVaultWithdrawSchema.safeParse({ assets: "0.1" }).success).toBe(true);
      expect(SapienVaultRedeemSchema.safeParse({ shares: "2" }).success).toBe(true);
    });

    it("should parse an empty get_position payload", () => {
      expect(SapienVaultGetPositionSchema.safeParse({}).success).toBe(true);
    });
  });

  describe("deposit", () => {
    it("should approve SAPIEN when allowance is insufficient and deposit", async () => {
      const atomicAssets = parseUnits(MOCK_WHOLE_ASSETS, MOCK_TOKEN_DECIMALS);

      const response = await actionProvider.deposit(mockWallet, { assets: MOCK_WHOLE_ASSETS });

      expect(mockApprove).toHaveBeenCalledWith(
        mockWallet,
        SAPIEN_TOKEN_ADDRESS,
        SAPIEN_VAULT_ADDRESS,
        atomicAssets,
      );
      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: SAPIEN_VAULT_ADDRESS,
        data: encodeFunctionData({
          abi: SAPIEN_VAULT_ABI,
          functionName: "deposit",
          args: [atomicAssets, MOCK_OWNER],
        }),
      });
      expect(mockWallet.waitForTransactionReceipt).toHaveBeenCalledWith(MOCK_TX_HASH);
      expect(response).toContain(`Deposited ${MOCK_WHOLE_ASSETS} SAPIEN`);
      expect(response).toContain(MOCK_TX_HASH);
      expect(response).toContain(JSON.stringify(MOCK_RECEIPT));
    });

    it("should skip approve when allowance is already sufficient", async () => {
      mockReadContract.mockImplementation(({ address, functionName }) => {
        if (functionName === "decimals") {
          return address === SAPIEN_VAULT_ADDRESS ? MOCK_SHARE_DECIMALS : MOCK_TOKEN_DECIMALS;
        }
        if (functionName === "allowance") {
          return parseUnits("100", MOCK_TOKEN_DECIMALS);
        }
        if (functionName === "maxDeposit") {
          return MOCK_MAX_DEPOSIT;
        }
        if (functionName === "previewDeposit") {
          return MOCK_PREVIEW_SHARES;
        }
        throw new Error(`Unexpected readContract call: ${functionName}`);
      });

      const response = await actionProvider.deposit(mockWallet, {
        assets: MOCK_WHOLE_ASSETS,
        receiver: MOCK_RECEIVER,
      });

      expect(mockApprove).not.toHaveBeenCalled();
      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: SAPIEN_VAULT_ADDRESS,
        data: encodeFunctionData({
          abi: SAPIEN_VAULT_ABI,
          functionName: "deposit",
          args: [parseUnits(MOCK_WHOLE_ASSETS, MOCK_TOKEN_DECIMALS), MOCK_RECEIVER],
        }),
      });
      expect(response).toContain("Deposited");
      expect(response).toContain(MOCK_RECEIVER);
    });

    it("should reject a zero deposit", async () => {
      const response = await actionProvider.deposit(mockWallet, { assets: "0" });
      expect(response).toBe("Error: Assets amount must be greater than 0");
      expect(mockWallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("should reject deposits above maxDeposit", async () => {
      mockReadContract.mockImplementation(({ functionName }) => {
        if (functionName === "decimals") {
          return MOCK_TOKEN_DECIMALS;
        }
        if (functionName === "maxDeposit") {
          return 0n;
        }
        throw new Error(`Unexpected readContract call: ${functionName}`);
      });

      const response = await actionProvider.deposit(mockWallet, { assets: MOCK_WHOLE_ASSETS });
      expect(response).toContain("exceeds maxDeposit");
      expect(mockWallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("should return a clear error on non-Base networks", async () => {
      mockWallet.getNetwork.mockReturnValue({
        protocolFamily: "evm",
        networkId: "ethereum-mainnet",
        chainId: "1",
      } as Network);

      const response = await actionProvider.deposit(mockWallet, { assets: MOCK_WHOLE_ASSETS });
      expect(response).toContain("only supported on Base mainnet");
      expect(response).toContain("ethereum-mainnet");
      expect(mockWallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("should handle deposit transaction errors", async () => {
      mockWallet.sendTransaction.mockRejectedValue(new Error("Failed to deposit"));

      const response = await actionProvider.deposit(mockWallet, { assets: MOCK_WHOLE_ASSETS });
      expect(response).toContain("Error depositing to Sapien Vault: Error: Failed to deposit");
    });
  });

  describe("withdraw", () => {
    it("should withdraw SAPIEN by asset amount", async () => {
      const atomicAssets = parseUnits(MOCK_WHOLE_ASSETS, MOCK_TOKEN_DECIMALS);

      const response = await actionProvider.withdraw(mockWallet, { assets: MOCK_WHOLE_ASSETS });

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: SAPIEN_VAULT_ADDRESS,
        data: encodeFunctionData({
          abi: SAPIEN_VAULT_ABI,
          functionName: "withdraw",
          args: [atomicAssets, MOCK_OWNER, MOCK_OWNER],
        }),
      });
      expect(response).toContain(`Withdrawn ${MOCK_WHOLE_ASSETS} SAPIEN`);
      expect(response).toContain(MOCK_TX_HASH);
    });

    it("should reject withdraws above maxWithdraw", async () => {
      mockReadContract.mockImplementation(({ functionName }) => {
        if (functionName === "decimals") {
          return MOCK_TOKEN_DECIMALS;
        }
        if (functionName === "maxWithdraw") {
          return 0n;
        }
        throw new Error(`Unexpected readContract call: ${functionName}`);
      });

      const response = await actionProvider.withdraw(mockWallet, { assets: MOCK_WHOLE_ASSETS });
      expect(response).toContain("exceeds maxWithdraw");
      expect(mockWallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("should handle withdraw errors", async () => {
      mockWallet.sendTransaction.mockRejectedValue(new Error("Failed to withdraw"));

      const response = await actionProvider.withdraw(mockWallet, { assets: MOCK_WHOLE_ASSETS });
      expect(response).toContain("Error withdrawing from Sapien Vault: Error: Failed to withdraw");
    });
  });

  describe("redeem", () => {
    it("should redeem vSAPIEN shares", async () => {
      const atomicShares = parseUnits(MOCK_WHOLE_SHARES, MOCK_SHARE_DECIMALS);

      const response = await actionProvider.redeem(mockWallet, { shares: MOCK_WHOLE_SHARES });

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: SAPIEN_VAULT_ADDRESS,
        data: encodeFunctionData({
          abi: SAPIEN_VAULT_ABI,
          functionName: "redeem",
          args: [atomicShares, MOCK_OWNER, MOCK_OWNER],
        }),
      });
      expect(response).toContain(`Redeemed ${MOCK_WHOLE_SHARES} vSAPIEN`);
      expect(response).toContain(MOCK_TX_HASH);
    });

    it("should reject a zero redeem", async () => {
      const response = await actionProvider.redeem(mockWallet, { shares: "0" });
      expect(response).toBe("Error: Shares amount must be greater than 0");
    });

    it("should handle redeem errors", async () => {
      mockWallet.sendTransaction.mockRejectedValue(new Error("Failed to redeem"));

      const response = await actionProvider.redeem(mockWallet, { shares: MOCK_WHOLE_SHARES });
      expect(response).toContain("Error redeeming from Sapien Vault: Error: Failed to redeem");
    });
  });

  describe("get_position", () => {
    it("should return shares and assets and exclude RewardsController from user TVL", async () => {
      const response = await actionProvider.getPosition(mockWallet, {});

      expect(response).toContain(MOCK_OWNER);
      expect(response).toContain("1.5");
      expect(response).toContain("1.52");
      expect(response).toContain("user TVL");
      expect(response).toContain(SAPIEN_REWARDS_CONTROLLER_ADDRESS);
      expect(response).toContain("excludes RewardsController");
      expect(response).toContain("1010");
      expect(response).not.toMatch(/SAPIEN assets \(user TVL\): 1010/);
    });

    it("should read a specified address", async () => {
      const response = await actionProvider.getPosition(mockWallet, { address: MOCK_RECEIVER });
      expect(response).toContain(MOCK_RECEIVER);
    });

    it("should handle read errors", async () => {
      mockReadContract.mockRejectedValue(new Error("rpc down"));
      const response = await actionProvider.getPosition(mockWallet, {});
      expect(response).toContain("Error reading Sapien Vault position: Error: rpc down");
    });
  });

  describe("supportsNetwork", () => {
    it("should return true for Base mainnet", () => {
      expect(
        actionProvider.supportsNetwork({
          protocolFamily: "evm",
          networkId: "base-mainnet",
          chainId: "8453",
        }),
      ).toBe(true);
    });

    it("should return true for Base mainnet identified only by chainId", () => {
      expect(
        actionProvider.supportsNetwork({
          protocolFamily: "evm",
          chainId: "8453",
        }),
      ).toBe(true);
    });

    it("should return false for Base Sepolia", () => {
      expect(
        actionProvider.supportsNetwork({
          protocolFamily: "evm",
          networkId: "base-sepolia",
          chainId: "84532",
        }),
      ).toBe(false);
    });

    it("should return false for other EVM networks", () => {
      expect(
        actionProvider.supportsNetwork({
          protocolFamily: "evm",
          networkId: "ethereum-mainnet",
        }),
      ).toBe(false);
    });

    it("should return false for non-EVM networks", () => {
      expect(
        actionProvider.supportsNetwork({
          protocolFamily: "svm",
          networkId: "base-mainnet",
        }),
      ).toBe(false);
    });
  });
});
