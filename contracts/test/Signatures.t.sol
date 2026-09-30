// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {GameVault} from "../src/GameVault.sol";
import {IGameVault, OUTCOME_WIN, OUTCOME_VOID} from "../src/interfaces/IGameVault.sol";
import {VaultTestBase} from "./utils/VaultTestBase.sol";
import {MockERC1271Wallet} from "./mocks/Wallets.sol";

/// Signature binding and replay (docs/WAGER.md §3.3, §3.7 bound 6, §9.1 "Signatures").
contract SignaturesTest is VaultTestBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 internal M1; // alice's ("sig-1")
    bytes32 internal M2; // alice's ("sig-2")

    function setUp() public override {
        super.setUp();
        M1 = _mid(alice, keccak256("sig-1"));
        M2 = _mid(alice, keccak256("sig-2"));
    }

    // ---- another vault, another chain ----------------------------------------------------------------------------

    function test_entry_notValidOnAnotherVault() public {
        _ready(1_000e18);
        GameVault v2 = _newVault(address(token));
        // Same players, same keys, funded and authorised on the second vault too.
        _fundOn(v2, alice, 100e18);
        _fundOn(v2, bob, 100e18);
        _openOn(v2, alicePk, aliceKey);
        _openOn(v2, bobPk, bobKey);

        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a); // signed for `vault`
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        v2.lock(a, sigA, b, sigB);
        vault.lock(a, sigA, b, sigB);
    }

    function test_sessionAuth_andResult_notValidOnAnotherVault() public {
        GameVault v2 = _newVault(address(token));
        IGameVault.SessionAuth memory auth = _auth(alice, aliceKey, 10e18, 100e18, uint64(block.timestamp + 1 days));
        bytes memory sig = _sign(alicePk, _hashAuth(auth)); // for `vault`
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        v2.openSession(auth, sig);

        // A referee Result for a match on `vault` does nothing on v2, even for a match with the same id there.
        _ready(1_000e18);
        _lock(M1, 10e18);
        _fundOn(v2, alice, 10e18);
        _fundOn(v2, bob, 10e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        v2.lock(a, _sign(alicePk, v2.hashEntry(a)), b, _sign(bobPk, v2.hashEntry(b)));
        IGameVault.Result memory r = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory rs = _signResult(refereePk, r);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        v2.settle(r, rs);
        vault.settle(r, rs);
    }

    function test_signatures_notValidOnAnotherChain() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        IGameVault.SessionAuth memory auth = _auth(carol, aliceKey, 10e18, 100e18, uint64(block.timestamp + 1 days));
        bytes memory authSig = _sign(carolPk, _hashAuth(auth));
        uint256 chain = vm.getChainId();

        vm.chainId(46630); // e.g. a fork, or the same vault address on another chain
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.lock(a, sigA, b, sigB);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, carol));
        vault.openSession(auth, authSig);
        (,,, uint256 domainChain,,,) = vault.eip712Domain();
        assertEq(domainChain, 46630, "the domain follows the chain id");

        vm.chainId(chain);
        vault.lock(a, sigA, b, sigB);
        vault.openSession(auth, authSig);
    }

    // ---- results bound to their match -----------------------------------------------------------------------------

    function test_result_forOneMatchDoesNotSettleAnother() public {
        _ready(1_000e18);
        _lock(M1, 10e18);
        _lock(M2, 10e18);
        IGameVault.Result memory r1 = _result(M1, OUTCOME_WIN, alice, FEE);
        bytes memory sig1 = _signResult(refereePk, r1);
        IGameVault.Result memory r2 = _result(M2, OUTCOME_WIN, alice, FEE);
        r2.logHash = r1.logHash;
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r2, sig1);
        // Changing the log hash, the fee or the outcome also breaks it.
        IGameVault.Result memory r3 = _result(M1, OUTCOME_WIN, alice, FEE);
        r3.logHash = keccak256("another log");
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(r3, sig1);
        vault.settle(r1, sig1);
        assertEq(uint8(vault.matchOf(M2).state), uint8(IGameVault.MatchState.Locked));
    }

    function test_entries_consumedWithTheirMatchId() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vault.lock(a, sigA, b, sigB);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.MatchExists.selector, M1));
        vault.lock(a, sigA, b, sigB);
        // Still refused after the match is over (settled or voided): a match id is used once, ever.
        _void(M1);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.MatchExists.selector, M1));
        vault.lock(a, sigA, b, sigB);
        // An open Entry can't be reused with a different joiner either: its match id is spent.
        IGameVault.Entry memory c = _entry(M1, carol, alice, 10e18);
        bytes memory sigC = _signEntry(carolPk, c);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.MatchExists.selector, M1));
        vault.lock(a, sigA, c, sigC);
    }

    function test_entry_signatureCannotBeMovedToAnotherPlayer() public {
        _ready(1_000e18);
        _deposit(carol, 100e18);
        // Bob's session key signed an Entry for bob; the relay tries to use it as carol's.
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        b.player = carol;
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, carol));
        vault.lock(a, sigA, b, sigB);
        // Or with a bigger stake than signed.
        b.player = bob;
        a.stake = 20e18;
        b.stake = 20e18;
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.lock(a, sigA, b, sigB);
    }

    function test_stranger_cannotTakeNamedSeat() public {
        _ready(1_000e18);
        _deposit(carol, 100e18);
        // Alice invites bob by name; carol (with her own valid signature) can't take the seat.
        IGameVault.Entry memory a = _entry(M1, alice, bob, 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        IGameVault.Entry memory c = _entry(M1, carol, alice, 10e18);
        bytes memory sigC = _signEntry(carolPk, c);
        vm.expectRevert(IGameVault.EntryMismatch.selector);
        vault.lock(a, sigA, c, sigC);
        // Nor by claiming to be bob.
        c = _entry(M1, bob, alice, 10e18);
        sigC = _signEntry(carolPk, c);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, bob));
        vault.lock(a, sigA, c, sigC);
    }

    function test_sessionKey_onlyEntersItsOwnPlayer() public {
        _ready(1_000e18);
        _deposit(carol, 100e18);
        // Bob's session key signing an Entry for carol is refused.
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        bytes memory sigA = _signEntry(aliceKeyPk, a);
        IGameVault.Entry memory c = _entry(M1, carol, alice, 10e18);
        bytes memory sigC = _signEntry(bobKeyPk, c);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, carol));
        vault.lock(a, sigA, c, sigC);
    }

    // ---- malleability and malformed signatures ----------------------------------------------------------------------

    function test_highS_rejected() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKeyPk, _hashEntry(a));
        // The same point with s' = n - s and the other v: ecrecover accepts it, the vault must not.
        bytes memory malleated = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        assertEq(ecrecover(_hashEntry(a), v == 27 ? 28 : 27, r, bytes32(SECP256K1_N - uint256(s))), aliceKey);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.lock(a, malleated, b, sigB);

        IGameVault.Result memory res = _result(M1, OUTCOME_VOID, address(0), 0);
        vault.lock(a, abi.encodePacked(r, s, v), b, sigB);
        (v, r, s) = vm.sign(refereePk, _hashResult(res));
        bytes memory badRes = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, referee));
        vault.settle(res, badRes);
    }

    function test_malformedSignatures_rejected() public {
        _ready(1_000e18);
        IGameVault.Entry memory a = _entry(M1, alice, address(0), 10e18);
        IGameVault.Entry memory b = _entry(M1, bob, alice, 10e18);
        bytes memory good = _signEntry(aliceKeyPk, a);
        bytes memory sigB = _signEntry(bobKeyPk, b);
        (bytes32 r, bytes32 vs) = vm.signCompact(aliceKeyPk, _hashEntry(a));
        bytes[4] memory bad = [
            bytes(""),
            abi.encodePacked(r, vs), // ERC-2098 64-byte form: not accepted
            abi.encodePacked(good, uint8(0)), // 66 bytes
            abi.encodePacked(bytes32(0), bytes32(0), uint8(27)) // recovers to address(0)
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
            vault.lock(a, bad[i], b, sigB);
        }
        vault.lock(a, good, b, sigB);
    }

    // ---- contract wallets (ERC-1271) and EIP-7702 accounts ----------------------------------------------------------

    /// A funded ERC-1271 wallet owned by carol's key, with a session key of its own.
    function _walletWithSession() internal returns (MockERC1271Wallet w, uint256 wKeyPk) {
        w = new MockERC1271Wallet(carol);
        require(token.transfer(address(w), 500e18));
        vm.startPrank(carol);
        w.exec(address(token), abi.encodeCall(token.approve, (address(vault), 500e18)));
        w.exec(address(vault), abi.encodeCall(vault.deposit, (500e18)));
        vm.stopPrank();
        assertEq(vault.freeOf(address(w)), 500e18);
        // SessionAuth signed through ERC-1271 (carol's key signs for the wallet).
        address wKey;
        (wKey, wKeyPk) = makeAddrAndKey("wallet session key");
        IGameVault.SessionAuth memory auth = _auth(address(w), wKey, 100e18, 1_000e18, uint64(block.timestamp + 1 days));
        vault.openSession(auth, _sign(carolPk, _hashAuth(auth)));
        assertEq(vault.sessionOf(address(w)).key, wKey);
        _deposit(bob, 500e18);
    }

    function test_erc1271Wallet_entriesBySessionKeyAndByWallet() public {
        (MockERC1271Wallet w, uint256 wKeyPk) = _walletWithSession();
        bytes32 m1 = _mid(address(w), keccak256("sig-1"));
        bytes32 m2 = _mid(address(w), keccak256("sig-2"));
        IGameVault.Entry memory a = _entry(m1, address(w), address(0), 100e18);
        IGameVault.Entry memory b = _entry(m1, bob, address(w), 100e18);
        vault.lock(a, _signEntry(wKeyPk, a), b, _signEntry(bobPk, b));
        a = _entry(m2, address(w), address(0), 100e18);
        b = _entry(m2, bob, address(w), 100e18);
        vault.lock(a, _signEntry(carolPk, a), b, _signEntry(bobPk, b));
        assertEq(vault.sessionOf(address(w)).used, 100e18, "the wallet-signed Entry spends no session");
        // A refusing wallet (contract signatures are revocable) can't enter by ERC-1271.
        vm.prank(carol);
        w.setRefuse(true);
        bytes32 m3 = _mid(address(w), keccak256("sig-3"));
        a = _entry(m3, address(w), address(0), 100e18);
        b = _entry(m3, bob, address(w), 100e18);
        bytes memory sigA = _signEntry(carolPk, a);
        bytes memory sigB = _signEntry(bobPk, b);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, address(w)));
        vault.lock(a, sigA, b, sigB);
    }

    function test_erc1271Wallet_mutualSettleAndWithdraw() public {
        (MockERC1271Wallet w, uint256 wKeyPk) = _walletWithSession();
        bytes32 m1 = _mid(address(w), keccak256("sig-1"));
        IGameVault.Entry memory a = _entry(m1, address(w), address(0), 100e18);
        IGameVault.Entry memory b = _entry(m1, bob, address(w), 100e18);
        vault.lock(a, _signEntry(wKeyPk, a), b, _signEntry(bobPk, b));

        // Mutual settle: the wallet (ERC-1271) and bob agree; the wallet's session key may not stand in.
        IGameVault.Result memory r = _result(m1, OUTCOME_WIN, address(w), FEE);
        bytes memory sigW = _signResult(carolPk, r);
        bytes memory sigB = _signResult(bobPk, r);
        bytes memory sigWKey = _signResult(wKeyPk, r);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, address(w)));
        vault.settleMutual(r, sigWKey, sigB);
        vault.settleMutual(r, sigW, sigB);
        assertEq(vault.freeOf(address(w)), 400e18 + 194e18);

        // Withdrawal needs no signature at all: the wallet calls it.
        vm.prank(carol);
        w.exec(address(vault), abi.encodeCall(vault.withdraw, (594e18)));
        assertEq(token.balanceOf(address(w)), 594e18);
    }

    function test_eip7702Account_stillSignsWithItsKey() public {
        // An EOA with delegated code (EIP-7702) keeps signing with its own key; SignatureChecker alone would only try
        // ERC-1271 once the account has code.
        MockERC1271Wallet impl = new MockERC1271Wallet(address(0xdead));
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(impl)));
        assertGt(alice.code.length, 0);
        IGameVault.SessionAuth memory auth = _auth(alice, aliceKey, 10e18, 100e18, uint64(block.timestamp + 1 days));
        vault.openSession(auth, _sign(alicePk, _hashAuth(auth)));
        assertEq(vault.sessionOf(alice).key, aliceKey);
    }

    // ---- nonces ----------------------------------------------------------------------------------------------------

    function test_sessionAuth_nonceBoundAndSingleUse() public {
        IGameVault.SessionAuth memory first = _auth(alice, aliceKey, 10e18, 100e18, uint64(block.timestamp + 1 days));
        bytes memory firstSig = _sign(alicePk, _hashAuth(first));
        vault.openSession(first, firstSig);
        // A second auth signed for nonce 1 works once.
        (address k2,) = makeAddrAndKey("k2");
        IGameVault.SessionAuth memory second = _auth(alice, k2, 10e18, 100e18, uint64(block.timestamp + 1 days));
        bytes memory secondSig = _sign(alicePk, _hashAuth(second));
        vault.openSession(second, secondSig);
        // Neither comes back: after a revoke, or after another session.
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadNonce.selector, uint64(2), uint64(0)));
        vault.openSession(first, firstSig);
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadNonce.selector, uint64(2), uint64(1)));
        vault.openSession(second, secondSig);
        // A replay under a forged nonce fails the signature.
        first.nonce = 2;
        vm.expectRevert(abi.encodeWithSelector(IGameVault.BadSignature.selector, alice));
        vault.openSession(first, firstSig);
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------

    function _fundOn(GameVault v, address who, uint256 amount) internal {
        require(token.transfer(who, amount));
        vm.startPrank(who);
        token.approve(address(v), amount);
        v.deposit(amount);
        vm.stopPrank();
    }

    function _openOn(GameVault v, uint256 playerPk, address key) internal {
        address player = vm.addr(playerPk);
        IGameVault.SessionAuth memory a = IGameVault.SessionAuth({
            player: player,
            sessionKey: key,
            maxStake: MAX_STAKE,
            cap: 10 * MAX_STAKE,
            expiry: uint64(block.timestamp + 3 days),
            nonce: v.sessionNonce(player)
        });
        v.openSession(a, _sign(playerPk, v.hashSessionAuth(a)));
    }
}
