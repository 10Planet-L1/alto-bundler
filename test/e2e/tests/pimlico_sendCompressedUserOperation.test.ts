import { ENTRYPOINT_ADDRESS_V06_TYPE } from "permissionless/_types/types"
import { describe, test, beforeAll, expect } from "vitest"
import {
    getPimlicoBundlerClient,
    getSmartAccountClient,
    sendBundleNow,
    setBundlingMode
} from "../src/utils"
import { ENTRYPOINT_ADDRESS_V06 } from "permissionless/utils"
import {
    createPublicClient,
    createTestClient,
    getContract,
    http,
    parseEther,
    parseGwei
} from "viem"
import { ANVIL_RPC } from "../src/constants"
import { foundry } from "viem/chains"
import { PimlicoBundlerClient } from "permissionless/clients/pimlico"

const publicClient = createPublicClient({
    transport: http(ANVIL_RPC),
    chain: foundry
})

const anvilClient = createTestClient({
    chain: foundry,
    mode: "anvil",
    transport: http(ANVIL_RPC)
})

const SIMPLE_INFLATOR_CONTRACT = getContract({
    address: "0x92d2f9ef7b520d91a34501fbb31e5428ab2fd5df",
    abi: [
        {
            type: "function",
            name: "compress",
            inputs: [
                {
                    name: "op",
                    type: "tuple",
                    components: [
                        { name: "sender", type: "address" },
                        { name: "nonce", type: "uint256" },
                        { name: "initCode", type: "bytes" },
                        { name: "callData", type: "bytes" },
                        { name: "callGasLimit", type: "uint256" },
                        { name: "verificationGasLimit", type: "uint256" },
                        { name: "preVerificationGas", type: "uint256" },
                        { name: "maxFeePerGas", type: "uint256" },
                        { name: "maxPriorityFeePerGas", type: "uint256" },
                        { name: "paymasterAndData", type: "bytes" },
                        { name: "signature", type: "bytes" }
                    ]
                }
            ],
            outputs: [
                {
                    name: "compressed",
                    type: "bytes"
                }
            ],
            stateMutability: "pure"
        }
    ] as const,
    client: publicClient
})

describe("V0.6 pimlico_sendCompressedUserOperation", () => {
    let pimlicoBundlerClient: PimlicoBundlerClient<ENTRYPOINT_ADDRESS_V06_TYPE>

    beforeAll(async () => {
        pimlicoBundlerClient = getPimlicoBundlerClient(ENTRYPOINT_ADDRESS_V06)
    })

    test("Send compressed UserOperation", async () => {
        const smartAccountClient = await getSmartAccountClient({
            entryPoint: ENTRYPOINT_ADDRESS_V06
        })
        const smartAccount = smartAccountClient.account

        const to = "0x23B608675a2B2fB1890d3ABBd85c5775c51691d5"
        const value = parseEther("0.15")

        const op = await smartAccountClient.prepareUserOperationRequest({
            userOperation: {
                callData: await smartAccount.encodeCallData({
                    to,
                    value,
                    data: "0x"
                })
            }
        })
        op.signature = await smartAccount.signUserOperation(op)

        const compressedUserOperation =
            await SIMPLE_INFLATOR_CONTRACT.read.compress([op])

        const hash = await pimlicoBundlerClient.sendCompressedUserOperation({
            compressedUserOperation,
            inflatorAddress: SIMPLE_INFLATOR_CONTRACT.address
        })

        await new Promise((resolve) => setTimeout(resolve, 1500))

        await pimlicoBundlerClient.waitForUserOperationReceipt({ hash })

        expect(
            await publicClient.getBalance({ address: to })
        ).toBeGreaterThanOrEqual(value)
    })

    test.only("Replace mempool transaction", async () => {
        const smartAccountClient = await getSmartAccountClient({
            entryPoint: ENTRYPOINT_ADDRESS_V06
        })
        const smartAccount = smartAccountClient.account

        await anvilClient.setAutomine(false)
        await anvilClient.mine({ blocks: 1 })

        const to = "0x23B608675a2B2fB1890d3ABBd85c5775c51691d5"
        const value = parseEther("0.15")

        const op = await smartAccountClient.prepareUserOperationRequest({
            userOperation: {
                callData: await smartAccount.encodeCallData({
                    to,
                    value,
                    data: "0x"
                })
            }
        })
        op.signature = await smartAccount.signUserOperation(op)

        const compressedUserOperation =
            await SIMPLE_INFLATOR_CONTRACT.read.compress([op])

        const hash = await pimlicoBundlerClient.sendCompressedUserOperation({
            compressedUserOperation,
            inflatorAddress: SIMPLE_INFLATOR_CONTRACT.address
        })

        await new Promise((resolve) => setTimeout(resolve, 1500))

        // increase next block base fee whilst current tx is in mempool
        await anvilClient.setNextBlockBaseFeePerGas({
            baseFeePerGas: parseGwei("150")
        })

        await anvilClient.mine({ blocks: 1 })
        await new Promise((resolve) => setTimeout(resolve, 1500))

        // check that no tx was mined
        let opReceipt = await pimlicoBundlerClient.getUserOperationReceipt({
            hash
        })
        expect(opReceipt).toBeNull()

        // new block should trigger alto's mempool to replace the eoa tx with too low gasPrice
        await anvilClient.mine({ blocks: 1 })
        await new Promise((resolve) => setTimeout(resolve, 1500))

        opReceipt = await pimlicoBundlerClient.getUserOperationReceipt({
            hash
        })

        expect(opReceipt?.success).equal(true)
        expect(
            await publicClient.getBalance({ address: to })
        ).toBeGreaterThanOrEqual(value)

        await anvilClient.setAutomine(true)
    })

    test("Send multiple compressedOps", async () => {
        const firstClient = await getSmartAccountClient({
            entryPoint: ENTRYPOINT_ADDRESS_V06
        })
        const secondClient = await getSmartAccountClient({
            entryPoint: ENTRYPOINT_ADDRESS_V06
        })

        const to = "0x23B608675a2B2fB1890d3ABBd85c5775c51691d5"
        const value = parseEther("0.15")

        // create sender op
        const firstOp = await firstClient.prepareUserOperationRequest({
            userOperation: {
                callData: await firstClient.account.encodeCallData({
                    to,
                    value: value,
                    data: "0x"
                })
            }
        })

        firstOp.signature = await firstClient.account.signUserOperation(firstOp)

        // create relayer op
        const secondOp = await secondClient.prepareUserOperationRequest({
            userOperation: {
                callData: await secondClient.account.encodeCallData({
                    to,
                    value,
                    data: "0x"
                })
            }
        })

        secondOp.signature =
            await secondClient.account.signUserOperation(secondOp)

        setBundlingMode("manual")

        const firstCompressedOp = await SIMPLE_INFLATOR_CONTRACT.read.compress([
            firstOp
        ])
        const firstHash =
            await pimlicoBundlerClient.sendCompressedUserOperation({
                compressedUserOperation: firstCompressedOp,
                inflatorAddress: SIMPLE_INFLATOR_CONTRACT.address
            })
        const secondCompressedOp = await SIMPLE_INFLATOR_CONTRACT.read.compress(
            [secondOp]
        )
        const secondHash =
            await pimlicoBundlerClient.sendCompressedUserOperation({
                compressedUserOperation: secondCompressedOp,
                inflatorAddress: SIMPLE_INFLATOR_CONTRACT.address
            })

        expect(
            await pimlicoBundlerClient.getUserOperationReceipt({
                hash: firstHash
            })
        ).toBeNull()
        expect(
            await pimlicoBundlerClient.getUserOperationReceipt({
                hash: secondHash
            })
        ).toBeNull()

        await sendBundleNow()

        expect(
            (
                await pimlicoBundlerClient.waitForUserOperationReceipt({
                    hash: firstHash
                })
            ).success
        ).toEqual(true)
        expect(
            (
                await pimlicoBundlerClient.waitForUserOperationReceipt({
                    hash: secondHash
                })
            ).success
        ).toEqual(true)

        expect(
            await publicClient.getBalance({ address: to })
        ).toBeGreaterThanOrEqual(value * 2n)

        setBundlingMode("auto")
        await anvilClient.setNextBlockBaseFeePerGas({
            baseFeePerGas: parseGwei("1")
        })
    })
})
