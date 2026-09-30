// SPDX-License-Identifier: LicenseRef-VPL
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {GameVault} from "../src/GameVault.sol";
import {TestSpiderTag} from "../src/TestSpiderTag.sol";
import {IGameVault} from "../src/interfaces/IGameVault.sol";

/// The vault's EIP-712 digests equal the shared TypeScript code's (src/wager/eip712.ts, computed with viem) and
/// Foundry's own EIP-712 encoder, and a viem signature by anvil key #0 recovers in the vault.
/// test/wager-contracts.test.ts recomputes the VECTOR_* constants below from eip712.ts, so if either side changes,
/// one of the two tests fails.
contract Eip712VectorsTest is Test {
    // anvil's well-known dev account #0 (a public test key; local tests only).
    uint256 internal constant ANVIL0_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant ANVIL0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant VAULT = 0x5FbDB2315678afecb367f032d93F642f64180aa3;

    // VECTOR_ENTRY_DIGEST, VECTOR_RESULT_DIGEST, VECTOR_AUTH_DIGEST and the signatures: viem, chain 31337, VAULT.
    bytes32 internal constant VECTOR_ENTRY_DIGEST = 0x1080155618481822387cb8b40279dbbfd1a3c065174ac4982416a111f4aa420c;
    bytes internal constant VECTOR_ENTRY_SIG =
        hex"1e7d7cfb311329cc74a6a9ddcec464003158e376f30c6fbc4e6fa12a444ecd7f0b69d321d530e2fb23f1a5c36de9282aea1b4d53fc9e31efd04eaff7e2721a311b";
    bytes32 internal constant VECTOR_RESULT_DIGEST = 0xf3923d76765852a1459aaa3102886224b083941f083a70a0c0d567cc2e5d7430;
    bytes internal constant VECTOR_RESULT_SIG =
        hex"c8c6fcf233e0e095b4539bc114194fe1d1df4c35b3c6ec9625f0bf4fea4a0b9d373f4243334a808cc36fee5366757234b6eb768678e51b8466ccdade0428fe921b";
    bytes32 internal constant VECTOR_AUTH_DIGEST = 0xa8ba3b072fefd34b05d5e61c20ba39cc1fdb3ddadb830682a827121bd83d9f15;
    bytes internal constant VECTOR_AUTH_SIG =
        hex"3da19f62ee206dc40c983a031b1b36d0dd917b4237597d43e4b9b70b39e245062db4c927648f0bcd82201bb29a646b808e5c290ca34dce4ea8bdcfc049c5a9f21c";

    GameVault internal vault;

    function setUp() public {
        vm.chainId(31337);
        TestSpiderTag token = new TestSpiderTag(address(this));
        deployCodeTo(
            "GameVault.sol:GameVault",
            abi.encode(
                address(token),
                address(1),
                address(2),
                address(3),
                uint16(300),
                uint16(150),
                uint128(1e21),
                uint128(1e24),
                uint32(1 days)
            ),
            VAULT
        );
        vault = GameVault(VAULT);
    }

    function _entry() internal pure returns (IGameVault.Entry memory) {
        return IGameVault.Entry({
            matchId: bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            player: ANVIL0,
            opponent: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            stake: 1e21,
            feeCapBps: 300,
            roundSeconds: 90,
            rules: bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
            deadline: 1_900_000_000
        });
    }

    function _result() internal pure returns (IGameVault.Result memory) {
        return IGameVault.Result({
            matchId: bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            outcome: 1,
            winner: ANVIL0,
            feeBps: 150,
            logHash: bytes32(0x3333333333333333333333333333333333333333333333333333333333333333)
        });
    }

    function _auth() internal pure returns (IGameVault.SessionAuth memory) {
        return IGameVault.SessionAuth({
            player: ANVIL0,
            sessionKey: 0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            maxStake: 5e20,
            cap: 5e21,
            expiry: 1_900_000_000,
            nonce: 0
        });
    }

    function test_digests_matchViem() public view {
        assertEq(vault.hashEntry(_entry()), VECTOR_ENTRY_DIGEST, "Entry");
        assertEq(vault.hashResult(_result()), VECTOR_RESULT_DIGEST, "Result");
        assertEq(vault.hashSessionAuth(_auth()), VECTOR_AUTH_DIGEST, "SessionAuth");
    }

    function test_signatures_matchViem() public pure {
        // RFC 6979 signatures are deterministic: viem and forge produce the same bytes for the same key and digest.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ANVIL0_PK, VECTOR_ENTRY_DIGEST);
        assertEq(abi.encodePacked(r, s, v), VECTOR_ENTRY_SIG);
        (v, r, s) = vm.sign(ANVIL0_PK, VECTOR_RESULT_DIGEST);
        assertEq(abi.encodePacked(r, s, v), VECTOR_RESULT_SIG);
        (v, r, s) = vm.sign(ANVIL0_PK, VECTOR_AUTH_DIGEST);
        assertEq(abi.encodePacked(r, s, v), VECTOR_AUTH_SIG);
    }

    function test_viemSessionAuth_opensSession() public {
        vm.warp(1_899_000_000);
        vault.openSession(_auth(), VECTOR_AUTH_SIG);
        assertEq(vault.sessionOf(ANVIL0).key, 0x90F79bf6EB2c4f870365E785982E1f101E93b906);
    }

    function test_digests_matchFoundryEncoder() public view {
        string memory domain = string.concat(
            '"domain":{"name":"RadRun GameVault","version":"1","chainId":31337,"verifyingContract":"',
            vm.toString(VAULT),
            '"}'
        );
        string memory entryJson = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"Entry":[{"name":"matchId","type":"bytes32"},{"name":"player","type":"address"},{"name":"opponent","type":"address"},{"name":"stake","type":"uint128"},{"name":"feeCapBps","type":"uint16"},{"name":"roundSeconds","type":"uint16"},{"name":"rules","type":"bytes32"},{"name":"deadline","type":"uint64"}]},',
            '"primaryType":"Entry",',
            domain,
            ',"message":{"matchId":"0x1111111111111111111111111111111111111111111111111111111111111111","player":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","opponent":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","stake":"1000000000000000000000","feeCapBps":300,"roundSeconds":90,"rules":"0x2222222222222222222222222222222222222222222222222222222222222222","deadline":1900000000}}'
        );
        assertEq(vm.eip712HashTypedData(entryJson), vault.hashEntry(_entry()), "Entry (Foundry)");
        string memory resultJson = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"Result":[{"name":"matchId","type":"bytes32"},{"name":"outcome","type":"uint8"},{"name":"winner","type":"address"},{"name":"feeBps","type":"uint16"},{"name":"logHash","type":"bytes32"}]},',
            '"primaryType":"Result",',
            domain,
            ',"message":{"matchId":"0x1111111111111111111111111111111111111111111111111111111111111111","outcome":1,"winner":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","feeBps":150,"logHash":"0x3333333333333333333333333333333333333333333333333333333333333333"}}'
        );
        assertEq(vm.eip712HashTypedData(resultJson), vault.hashResult(_result()), "Result (Foundry)");
    }
}
