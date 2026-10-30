use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("DkbdTSGUTomGLViLXtxvLMeQYQyrtmRxZ8B7MxpnbvHv");

#[program]
pub mod alias_registry {
    use super::*;

    pub fn register_alias(
        ctx: Context<RegisterAlias>,
        alias: String,
        duration_years: u8,
    ) -> Result<()> {
        require!(alias.len() >= 3 && alias.len() <= 15, AliasError::InvalidLength);
        require!(alias.chars().all(|c| c.is_alphanumeric() || c == '_'), AliasError::InvalidCharacters);
        require!(duration_years >= 1 && duration_years <= 10, AliasError::InvalidDuration);

        let fee = calculate_fee(&alias, duration_years);
        
        // Transfer fee to treasury
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            fee,
        )?;

        let alias_account = &mut ctx.accounts.alias_account;
        alias_account.alias = alias;
        alias_account.owner = ctx.accounts.payer.key();
        alias_account.created_at = Clock::get()?.unix_timestamp;
        alias_account.expires_at = Clock::get()?.unix_timestamp + (duration_years as i64 * 365 * 24 * 60 * 60);
        alias_account.is_verified = false;
        alias_account.bump = ctx.bumps.alias_account;

        emit!(AliasRegistered {
            alias: alias_account.alias.clone(),
            owner: alias_account.owner,
            expires_at: alias_account.expires_at,
        });

        Ok(())
    }

    pub fn transfer_alias(ctx: Context<TransferAlias>) -> Result<()> {
        let alias_account = &mut ctx.accounts.alias_account;
        require!(Clock::get()?.unix_timestamp < alias_account.expires_at, AliasError::AliasExpired);
        
        alias_account.owner = ctx.accounts.new_owner.key();
        alias_account.is_verified = false; // Reset verification on transfer

        emit!(AliasTransferred {
            alias: alias_account.alias.clone(),
            new_owner: alias_account.owner,
        });

        Ok(())
    }

    pub fn renew_alias(ctx: Context<RenewAlias>, duration_years: u8) -> Result<()> {
        require!(duration_years >= 1 && duration_years <= 10, AliasError::InvalidDuration);

        let alias_account = &mut ctx.accounts.alias_account;
        let fee = calculate_fee(&alias_account.alias, duration_years);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            fee,
        )?;

        let current_expiry = alias_account.expires_at;
        let now = Clock::get()?.unix_timestamp;
        let base_time = if current_expiry > now { current_expiry } else { now };
        alias_account.expires_at = base_time + (duration_years as i64 * 365 * 24 * 60 * 60);

        Ok(())
    }

    pub fn set_verified(ctx: Context<SetVerified>, verified: bool) -> Result<()> {
        ctx.accounts.alias_account.is_verified = verified;
        Ok(())
    }
}

fn calculate_fee(alias: &str, duration_years: u8) -> u64 {
    let base_fee: u64 = 100_000_000; // 0.1 SOL
    let length_multiplier = match alias.len() {
        3 => 50,      // Premium 3-char: 5 SOL/year
        4 => 20,      // Premium 4-char: 2 SOL/year
        5 => 5,       // 0.5 SOL/year
        _ => 1,       // Standard: 0.1 SOL/year
    };
    base_fee * length_multiplier * duration_years as u64
}

#[derive(Accounts)]
#[instruction(alias: String)]
pub struct RegisterAlias<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + AliasAccount::INIT_SPACE,
        seeds = [b"alias", alias.as_bytes()],
        bump
    )]
    pub alias_account: Account<'info, AliasAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Treasury account for collecting fees
    #[account(mut, seeds = [b"treasury"], bump)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAlias<'info> {
    #[account(mut, has_one = owner)]
    pub alias_account: Account<'info, AliasAccount>,
    pub owner: Signer<'info>,
    /// CHECK: New owner receiving the alias
    pub new_owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RenewAlias<'info> {
    #[account(mut)]
    pub alias_account: Account<'info, AliasAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Treasury account
    #[account(mut, seeds = [b"treasury"], bump)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetVerified<'info> {
    #[account(mut)]
    pub alias_account: Account<'info, AliasAccount>,
    #[account(constraint = authority.key() == ADMIN_PUBKEY @ AliasError::Unauthorized)]
    pub authority: Signer<'info>,
}

// Replace with actual admin pubkey
const ADMIN_PUBKEY: Pubkey = Pubkey::new_from_array([0; 32]);

#[account]
#[derive(InitSpace)]
pub struct AliasAccount {
    #[max_len(15)]
    pub alias: String,
    pub owner: Pubkey,
    pub created_at: i64,
    pub expires_at: i64,
    pub is_verified: bool,
    pub bump: u8,
}

#[event]
pub struct AliasRegistered {
    pub alias: String,
    pub owner: Pubkey,
    pub expires_at: i64,
}

#[event]
pub struct AliasTransferred {
    pub alias: String,
    pub new_owner: Pubkey,
}

#[error_code]
pub enum AliasError {
    #[msg("Alias must be 3-15 characters")]
    InvalidLength,
    #[msg("Alias can only contain alphanumeric characters and underscores")]
    InvalidCharacters,
    #[msg("Duration must be 1-10 years")]
    InvalidDuration,
    #[msg("Alias has expired")]
    AliasExpired,
    #[msg("Unauthorized")]
    Unauthorized,
}
