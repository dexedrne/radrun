// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title SPIDERTAG Test (tSPIDERTAG)
/// @notice The wager beta's test token, for test networks only (docs/WAGER.md §3.8). It has the shape of a launchpad
/// token: 18 decimals, a fixed supply of 1,000,000,000 minted once to `holder` (the faucet wallet), and burn. No owner,
/// mint, permit, tax, blacklist or pause. It has no value; the real token is launched separately and never by this
/// repo.
contract TestSpiderTag is ERC20, ERC20Burnable {
    uint256 public constant SUPPLY = 1_000_000_000 * 10 ** 18;

    constructor(address holder) ERC20("SPIDERTAG Test", "tSPIDERTAG") {
        _mint(holder, SUPPLY);
    }
}
