import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("alias-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AliasRegistry;
  const payer = provider.wallet;

  const getAliasPDA = (alias: string) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("alias"), Buffer.from(alias)],
      program.programId
    );
  };

  const getTreasuryPDA = () => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );
  };

  it("registers a new alias", async () => {
    const alias = "testuser";
    const [aliasPDA] = getAliasPDA(alias);
    const [treasuryPDA] = getTreasuryPDA();

    await program.methods
      .registerAlias(alias, 1)
      .accounts({
        aliasAccount: aliasPDA,
        payer: payer.publicKey,
        treasury: treasuryPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const account = await program.account.aliasAccount.fetch(aliasPDA);
    expect(account.alias).to.equal(alias);
    expect(account.owner.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(account.isVerified).to.be.false;
  });

  it("rejects invalid alias length", async () => {
    const alias = "ab"; // Too short
    const [aliasPDA] = getAliasPDA(alias);
    const [treasuryPDA] = getTreasuryPDA();

    try {
      await program.methods
        .registerAlias(alias, 1)
        .accounts({
          aliasAccount: aliasPDA,
          payer: payer.publicKey,
          treasury: treasuryPDA,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidLength");
    }
  });

  it("transfers alias to new owner", async () => {
    const alias = "transferme";
    const [aliasPDA] = getAliasPDA(alias);
    const [treasuryPDA] = getTreasuryPDA();
    const newOwner = Keypair.generate();

    // Register first
    await program.methods
      .registerAlias(alias, 1)
      .accounts({
        aliasAccount: aliasPDA,
        payer: payer.publicKey,
        treasury: treasuryPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Transfer
    await program.methods
      .transferAlias()
      .accounts({
        aliasAccount: aliasPDA,
        owner: payer.publicKey,
        newOwner: newOwner.publicKey,
      })
      .rpc();

    const account = await program.account.aliasAccount.fetch(aliasPDA);
    expect(account.owner.toBase58()).to.equal(newOwner.publicKey.toBase58());
  });

  it("renews an alias", async () => {
    const alias = "renewme";
    const [aliasPDA] = getAliasPDA(alias);
    const [treasuryPDA] = getTreasuryPDA();

    // Register
    await program.methods
      .registerAlias(alias, 1)
      .accounts({
        aliasAccount: aliasPDA,
        payer: payer.publicKey,
        treasury: treasuryPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const beforeAccount = await program.account.aliasAccount.fetch(aliasPDA);
    const beforeExpiry = beforeAccount.expiresAt.toNumber();

    // Renew for 2 more years
    await program.methods
      .renewAlias(2)
      .accounts({
        aliasAccount: aliasPDA,
        payer: payer.publicKey,
        treasury: treasuryPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const afterAccount = await program.account.aliasAccount.fetch(aliasPDA);
    const afterExpiry = afterAccount.expiresAt.toNumber();

    // Should be ~2 years more
    const twoYearsInSeconds = 2 * 365 * 24 * 60 * 60;
    expect(afterExpiry - beforeExpiry).to.be.closeTo(twoYearsInSeconds, 60);
  });
});
