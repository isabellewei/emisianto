import { ContractKit, newKit } from "@celo/contractkit";
import { BigNumber } from "bignumber.js";
import { useEffect, useState } from "react";
import { toast } from "../components";
import { OdisUtils } from "@celo/identity";
import WebBlsBlindingClient from "../components/bls-blinding-client";
import { useCelo } from "@celo/react-celo";
import "@celo/react-celo/lib/styles.css";
import { E164_REGEX } from "../services/twilio";
import { Account } from "web3-core";
import {
  AuthSigner,
  getServiceContext,
  OdisContextName,
} from "@celo/identity/lib/odis/query";
import { FederatedAttestationsWrapper } from "@celo/contractkit/lib/wrappers/FederatedAttestations";
import { OdisPaymentsWrapper } from "@celo/contractkit/lib/wrappers/OdisPayments";
import RegisterNumberModal from "./registerNumber";
import SendToNumberModal from "./sendToNumber";
import DeregisterNumberModal from "./deregisterNumber";
import { IdentifierPrefix } from "@celo/identity/lib/odis/identifier";

function App() {
  const { kit, connect, address, destroy, network } = useCelo();

  const ISSUER_PRIVATE_KEY = process.env.NEXT_PUBLIC_ISSUER_PRIVATE_KEY;
  let issuerKit: ContractKit,
    issuer: Account,
    federatedAttestationsContract: FederatedAttestationsWrapper,
    odisPaymentContract: OdisPaymentsWrapper;

  const [isRegisterNumberModalOpen, setIsRegisterNumberModalOpen] =
    useState(false);
  const [isSendToNumberModalOpen, setIsSendToNumberModalOpen] = useState(false);
  const [isDeregisterNumberModalOpen, setIsDeregisterNumberModalOpen] =
    useState(false);

  useEffect(() => {
    const intializeIssuer = async () => {
      issuerKit = newKit(network.rpcUrl);
      issuer =
        issuerKit.web3.eth.accounts.privateKeyToAccount(ISSUER_PRIVATE_KEY);
      issuerKit.addAccount(ISSUER_PRIVATE_KEY);
      issuerKit.defaultAccount = issuer.address;
      federatedAttestationsContract =
        await issuerKit.contracts.getFederatedAttestations();
      odisPaymentContract = await issuerKit.contracts.getOdisPayments();
    };
    intializeIssuer();
  });

  async function getIdentifier(phoneNumber: string) {
    try {
      if (!E164_REGEX.test(phoneNumber)) {
        throw "Attempting to hash a non-e164 number: " + phoneNumber;
      }
      const ONE_CENT_CUSD = issuerKit.web3.utils.toWei("0.01", "ether");

      let authMethod: any = OdisUtils.Query.AuthenticationMethod.WALLET_KEY;
      const authSigner: AuthSigner = {
        authenticationMethod: authMethod,
        //@ts-ignore typing issue
        contractKit: issuerKit,
      };

      const serviceContext = getServiceContext(OdisContextName.ALFAJORES);

      //check remaining quota
      const { remainingQuota } = await OdisUtils.Quota.getPnpQuotaStatus(
        issuer.address,
        authSigner,
        serviceContext
      );

      //increase quota if needed.
      console.log("remaining ODIS quota", remainingQuota);
      if (remainingQuota < 1) {
        // give odis payment contract permission to use cUSD
        const cusd = await issuerKit.contracts.getStableToken();
        const currrentAllowance = await cusd.allowance(
          issuer.address,
          odisPaymentContract.address
        );
        console.log("current allowance:", currrentAllowance.toString());
        let enoughAllowance: boolean = false;

        if (currrentAllowance < BigNumber(ONE_CENT_CUSD)) {
          const approvalTxReceipt = await cusd
            .increaseAllowance(odisPaymentContract.address, ONE_CENT_CUSD)
            .sendAndWaitForReceipt();
          console.log("approval status", approvalTxReceipt.status);
          enoughAllowance = approvalTxReceipt.status;
        } else {
          enoughAllowance = true;
        }

        // increase quota
        if (enoughAllowance) {
          const odisPayment = await odisPaymentContract
            .payInCUSD(issuer.address, ONE_CENT_CUSD)
            .sendAndWaitForReceipt();
          console.log("odis payment tx status:", odisPayment.status);
          console.log("odis payment tx hash:", odisPayment.transactionHash);
        } else {
          throw "cUSD approval failed";
        }
      }

      const blindingClient = new WebBlsBlindingClient(
        serviceContext.odisPubKey
      );
      await blindingClient.init();
      console.log("fetching identifier for:", phoneNumber);
      const response = await OdisUtils.Identifier.getObfuscatedIdentifier(
        phoneNumber,
        IdentifierPrefix.PHONE_NUMBER,
        issuer.address,
        authSigner,
        serviceContext,
        undefined,
        undefined,
        blindingClient
      );

      console.log(`Obfuscated phone number: ${response.obfuscatedIdentifier}`);

      console.log(
        `Obfuscated phone number is a result of: sha3('tel://${response.plaintextIdentifier}__${response.pepper}') => ${response.obfuscatedIdentifier}`
      );

      return response.obfuscatedIdentifier;
    } catch (error) {
      throw `failed to get identifier: ${error}`;
    }
  }

  // this function needs to be called once when using a new issuer address for the first time
  async function registerIssuerAccountAndWallet() {
    if (issuer.address == undefined) {
      throw "issuer not found";
    }
    const accountsContract = await issuerKit.contracts.getAccounts();

    // register account if needed
    let registeredAccount = await accountsContract.isAccount(issuer.address);
    if (!registeredAccount) {
      console.log("Registering account");
      const receipt = await accountsContract
        .createAccount()
        .sendAndWaitForReceipt({ from: issuer.address });
      console.log("Receipt status: ", receipt.status);
    } else {
      console.log("Account already registered");
    }

    // register wallet if needed
    let registeredWalletAddress = await accountsContract.getWalletAddress(
      issuer.address
    );
    console.log("Wallet address: ", registeredWalletAddress);
    if (
      registeredWalletAddress == "0x0000000000000000000000000000000000000000"
    ) {
      console.log(
        `Setting account's wallet address in Accounts.sol to ${issuer.address}`
      );
      const setWalletTx = await accountsContract
        .setWalletAddress(issuer.address)
        .sendAndWaitForReceipt();
      console.log("Receipt status: ", setWalletTx.status);
    } else {
      console.log("Account's wallet already registered");
    }
  }

  async function registerNumber(number: string) {
    try {
      const verificationTime = Math.floor(new Date().getTime() / 1000);

      const identifier = await getIdentifier(number);
      console.log(identifier);

      // TODO: lookup list of issuers per phone number.
      // This could be a good example to have for potential issuers to learn about this feature.

      const { accounts } =
        await federatedAttestationsContract.lookupAttestations(identifier, [
          issuer.address,
        ]);
      console.log(accounts);

      if (accounts.length == 0) {
        const attestationReceipt = await federatedAttestationsContract
          .registerAttestationAsIssuer(identifier, address, verificationTime)
          .sendAndWaitForReceipt();
        console.log("attestation Receipt status:", attestationReceipt.status);
        console.log(
          `Register Attestation as issuer TX hash: ${network.explorer}/tx/${attestationReceipt.transactionHash}/internal-transactions`
        );
      } else {
        console.log("phone number already registered with this issuer");
      }
    } catch (error) {
      throw `Error registering phone number: ${error}`;
    }
  }

  async function sendToNumber(number: string, amount: string) {
    try {
      const identifier = await getIdentifier(number);
      const amountInWei = issuerKit.web3.utils.toWei(amount, "ether");

      const attestations =
        await federatedAttestationsContract.lookupAttestations(identifier, [
          issuer.address,
        ]);

      // TODO: handle when no accounts mapped to number

      const CELO = await kit.contracts.getGoldToken();
      await CELO.transfer(
        attestations.accounts[0],
        amountInWei
      ).sendAndWaitForReceipt({ gasPrice: 20000000000 });
    } catch (error) {
      throw `Failed to send funds to ${number}: ${error}`;
    }
  }

  async function deregisterPhoneNumber(phoneNumber: string) {
    try {
      const identifier = await getIdentifier(phoneNumber);
      const receipt = await federatedAttestationsContract
        .revokeAttestation(identifier, issuer.address, address)
        .sendAndWaitForReceipt();
      console.log(
        `revoke attestation transaction receipt status: ${receipt.status}`
      );
    } catch (error) {
      throw `Failed to deregister phone number: ${error}`;
    }
  }

  return (
    <main>
      <br />
      {!address ? (
        <button
          onClick={() =>
            connect().catch((e) => toast.error((e as Error).message))
          }
          className="text-celo-green font-medium py-2 mb-2"
        >
          Connect your wallet
        </button>
      ) : (
        <div className="flex flex-col mx-auto content-center">
          <p className="">Connected Address: {address}</p>
          <button
            onClick={destroy}
            className="text-celo-green font-medium py-2 mb-2 self-center"
          >
            Disconnect your wallet
          </button>

          <div className="my-5 sm:mt-0">
            <div className="overflow-hidden shadow sm:rounded-md">
              <div className="bg-gray-50 px-4 py-5 text-center sm:px-6">
                <button
                  className="mr-3 inline-flex justify-center rounded-md border border-transparent bg-celo-green py-2 px-4 text-sm font-medium text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-celo-green focus:ring-offset-2"
                  onClick={() => setIsRegisterNumberModalOpen(true)}
                >
                  Verify and register your phone number
                </button>
              </div>
            </div>
          </div>

          <div className="my-5 sm:mt-0">
            <div className="overflow-hidden shadow sm:rounded-md">
              <div className="bg-gray-50 px-4 py-5 text-center sm:px-6">
                <button
                  className="mr-3 inline-flex justify-center rounded-md border border-transparent bg-celo-green py-2 px-4 text-sm font-medium text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-celo-green focus:ring-offset-2"
                  onClick={() => setIsSendToNumberModalOpen(true)}
                >
                  Send payment to a phone number
                </button>
              </div>
            </div>
          </div>

          <div className="my-5 sm:mt-0">
            <div className="overflow-hidden shadow sm:rounded-md">
              <div className="bg-gray-50 px-4 py-5 text-center sm:px-6">
                <button
                  className="mr-3 inline-flex justify-center rounded-md border border-transparent bg-celo-green py-2 px-4 text-sm font-medium text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-celo-green focus:ring-offset-2"
                  onClick={() => setIsDeregisterNumberModalOpen(true)}
                >
                  De-register your phone number
                </button>
              </div>
            </div>
          </div>

          <RegisterNumberModal
            isOpen={isRegisterNumberModalOpen}
            onDismiss={() => setIsRegisterNumberModalOpen(false)}
            registerNumber={registerNumber}
          />
          <SendToNumberModal
            isOpen={isSendToNumberModalOpen}
            onDismiss={() => setIsSendToNumberModalOpen(false)}
            sendToNumber={sendToNumber}
          />
          <DeregisterNumberModal
            isOpen={isDeregisterNumberModalOpen}
            onDismiss={() => setIsDeregisterNumberModalOpen(false)}
            deregisterNumber={deregisterPhoneNumber}
          />
        </div>
      )}
    </main>
  );
}

export default App;
