import {
  CeloContract,
  ContractKit,
  newKit,
  StableToken,
} from "@celo/contractkit";
import { ensureLeading0x } from "@celo/utils/lib/address";
import { BigNumber } from "bignumber.js";
import Head from "next/head";
import { useCallback, useEffect, useState } from "react";
import Web3 from "web3";
import { PrimaryButton, SecondaryButton, toast } from "../components";
import { OdisUtils } from "@celo/identity";
import WebBlsBlindingClient from "./bls-blinding-client";
import { Alfajores, CeloProvider, useCelo } from "@celo/react-celo";
import "@celo/react-celo/lib/styles.css";
import { sendSmsVerificationToken, verifyToken } from "../services/twilio";
import { Account } from "web3-core";
import { AuthSigner } from "@celo/identity/lib/odis/query";
import { FederatedAttestationsWrapper } from "@celo/contractkit/lib/wrappers/FederatedAttestations";
import { OdisPaymentsWrapper } from "@celo/contractkit/lib/wrappers/OdisPayments";

function App() {
  const { kit, connect, address, destroy } = useCelo();

  const E164_REGEX = /^\+[1-9][0-9]{1,14}$/;
  const ISSUER_PRIVATE_KEY = process.env.NEXT_PUBLIC_ISSUER_PRIVATE_KEY;
  let issuerKit: ContractKit,
    issuer: Account,
    federatedAttestationsContract: FederatedAttestationsWrapper,
    odisPaymentContract: OdisPaymentsWrapper;

  const [numberToRegister, setNumberToRegister] = useState("Phone Number");
  const [numberToSend, setNumberToSend] = useState("Receipient's Phone Number");
  const [userCode, setUserCode] = useState("Verification Code");
  const [sendAmount, setSendAmount] = useState("Amount to send");

  useEffect(() => {
    const intializeIssuer = async () => {
      issuerKit = newKit("https://alfajores-forno.celo-testnet.org");
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

      const serviceContext = OdisUtils.Query.ODIS_ALFAJORESSTAGING_CONTEXT;

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
      const response =
        await OdisUtils.PhoneNumberIdentifier.getPhoneNumberIdentifier(
          phoneNumber,
          issuer.address,
          authSigner,
          serviceContext,
          undefined,
          undefined,
          blindingClient
        );

      console.log(`Obfuscated phone number: ${response.phoneHash}`);

      console.log(
        `Obfuscated phone number is a result of: sha3('tel://${response.e164Number}__${response.pepper}') => ${response.phoneHash}`
      );

      return response.phoneHash;
    } catch (error) {
      throw `failed to get identifier: ${error}`;
    }
  }

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

  async function registerNumber() {
    try {
      const successfulVerification = await verifyToken(
        numberToRegister,
        userCode
      );
      if (successfulVerification) {
        const verificationTime = Math.floor(new Date().getTime() / 1000);

        const identifier = await getIdentifier(numberToRegister);
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
          console.log("attestation Receipt:", attestationReceipt.status);
          console.log(
            `Register Attestation as issuer TX hash: https://explorer.celo.org/alfajores/tx/${attestationReceipt.transactionHash}/internal-transactions`
          );
        } else {
          console.log("phone number already registered with this issuer");
        }
      }
    } catch (error) {
      throw `Error registering phone number: ${error}`;
    }
  }

  async function sendToNumber(amount: string) {
    try {
      const identifier = await getIdentifier(numberToSend);
      const amountInWei = issuerKit.web3.utils.toWei(amount, "ether");

      const attestations =
        await federatedAttestationsContract.lookupAttestations(identifier, [
          issuer.address,
        ]);

      const CELO = await kit.contracts.getGoldToken();
      await CELO.transfer(
        attestations.accounts[0],
        amountInWei
      ).sendAndWaitForReceipt({ gasPrice: 20000000000 });
    } catch (error) {
      throw `Failed to send funds to number: ${error}`;
    }
  }

  return (
    <main>
      <h1>Issuer to verify, register, and lookup numbers</h1>
      <br />
      <div>
        {/* TODO: Remove button before deploying web app */}
        <button onClick={() => registerIssuerAccountAndWallet()}>
          Register issuer
        </button>
      </div>
      {!address ? (
        <button
          onClick={() =>
            connect().catch((e) => toast.error((e as Error).message))
          }
        >
          Connect your wallet
        </button>
      ) : (
        <div>
          <p className="subtext">
            <i>Connected Address: </i>
            {address}
          </p>
          <button onClick={destroy}>Disconnect your wallet</button>
          <div className="sections">
            <div>
              <p>
                Verify and register
                <br />
                your phone number.
              </p>
              <input
                value={numberToRegister}
                onChange={(e) => setNumberToRegister(e.target.value)}
                type="text"
              />
              <button
                onClick={() => sendSmsVerificationToken(numberToRegister)}
              >
                Verify
              </button>
              <br />
              <input
                value={userCode}
                onChange={(e) => setUserCode(e.target.value)}
                type="text"
              />
              <button
                onClick={async () => {
                  await registerNumber();
                }}
              >
                Register
              </button>
            </div>
            <div>
              <p>Send payment to phone number</p>
              <input
                value={numberToSend}
                onChange={(e) => setNumberToSend(e.target.value)}
                type="text"
              />
              <input
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                type="text"
              />
              <button onClick={() => sendToNumber(sendAmount)}>Send</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function WrappedApp() {
  return (
    <CeloProvider
      dapp={{
        name: "Register Phone Number",
        description: "This app allows you to register a number with Celo",
        url: "https://example.com",
        icon: "",
      }}
      network={Alfajores}
    >
      <App />
    </CeloProvider>
  );
}
export default WrappedApp;
