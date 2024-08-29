import type { Metrics, Logger, BundlingStatus } from "@alto/utils"
import type { EventManager, GasPriceManager } from "@alto/handlers"
import type {
    InterfaceReputationManager,
    MemoryMempool,
    Monitor
} from "@alto/mempool"
import {
    type BundleResult,
    type BundlingMode,
    type HexData32,
    type MempoolUserOperation,
    type SubmittedUserOperation,
    type TransactionInfo,
    deriveUserOperation,
    isCompressedType,
    type UserOperation,
    type CompressedUserOperation,
    type UserOperationInfo,
    EntryPointV06Abi,
    logSchema,
    receiptSchema,
    type GetUserOperationReceiptResponseResult
} from "@alto/types"
import { getAAError, getBundleStatus } from "@alto/utils"
import {
    decodeEventLog,
    encodeEventTopics,
    getAbiItem,
    parseAbi,
    type TransactionReceipt,
    TransactionReceiptNotFoundError,
    zeroAddress,
    type Address,
    type Block,
    type Chain,
    type Hash,
    type PublicClient,
    type Transport,
    type WatchBlocksReturnType
} from "viem"
import type { Executor, ReplaceTransactionResult } from "./executor"
import { z } from "zod"
import { fromZodError } from "zod-validation-error"

function getTransactionsFromUserOperationEntries(
    entries: SubmittedUserOperation[]
): TransactionInfo[] {
    return Array.from(
        new Set(
            entries.map((entry) => {
                return entry.transactionInfo
            })
        )
    )
}

export class ExecutorManager {
    private entryPoints: Address[]
    private executor: Executor
    private mempool: MemoryMempool
    private monitor: Monitor
    private publicClient: PublicClient<Transport, Chain>
    private pollingInterval: number
    private logger: Logger
    private metrics: Metrics
    private reputationManager: InterfaceReputationManager
    private unWatch: WatchBlocksReturnType | undefined
    private currentlyHandlingBlock = false
    private timer?: NodeJS.Timer
    private bundlerFrequency: number
    private maxGasLimitPerBundle: bigint
    private gasPriceManager: GasPriceManager
    private eventManager: EventManager
    private aa95ResubmitMultiplier: bigint
    rpcMaxBlockRange: number | undefined

    constructor(
        executor: Executor,
        entryPoints: Address[],
        mempool: MemoryMempool,
        monitor: Monitor,
        reputationManager: InterfaceReputationManager,
        publicClient: PublicClient<Transport, Chain>,
        pollingInterval: number,
        logger: Logger,
        metrics: Metrics,
        bundleMode: BundlingMode,
        bundlerFrequency: number,
        maxGasLimitPerBundle: bigint,
        gasPriceManager: GasPriceManager,
        eventManager: EventManager,
        aa95ResubmitMultiplier: bigint,
        rpcMaxBlockRange: number | undefined
    ) {
        this.entryPoints = entryPoints
        this.reputationManager = reputationManager
        this.executor = executor
        this.mempool = mempool
        this.monitor = monitor
        this.publicClient = publicClient
        this.pollingInterval = pollingInterval
        this.logger = logger
        this.metrics = metrics
        this.bundlerFrequency = bundlerFrequency
        this.maxGasLimitPerBundle = maxGasLimitPerBundle
        this.gasPriceManager = gasPriceManager
        this.eventManager = eventManager
        this.aa95ResubmitMultiplier = aa95ResubmitMultiplier
        this.rpcMaxBlockRange = rpcMaxBlockRange

        if (bundleMode === "auto") {
            this.timer = setInterval(async () => {
                await this.bundle()
            }, bundlerFrequency) as NodeJS.Timer
        }
    }

    setBundlingMode(bundleMode: BundlingMode): void {
        if (bundleMode === "auto" && !this.timer) {
            this.timer = setInterval(async () => {
                await this.bundle()
            }, this.bundlerFrequency) as NodeJS.Timer
        } else if (bundleMode === "manual" && this.timer) {
            clearInterval(this.timer)
            this.timer = undefined
        }
    }

    async bundleNow(): Promise<Hash[]> {
        const ops = await this.mempool.process(this.maxGasLimitPerBundle, 1)
        if (ops.length === 0) {
            throw new Error("no ops to bundle")
        }

        const opEntryPointMap = new Map<Address, MempoolUserOperation[]>()

        for (const op of ops) {
            if (!opEntryPointMap.has(op.entryPoint)) {
                opEntryPointMap.set(op.entryPoint, [])
            }
            opEntryPointMap.get(op.entryPoint)?.push(op.mempoolUserOperation)
        }

        const txHashes: Hash[] = []

        await Promise.all(
            this.entryPoints.map(async (entryPoint) => {
                const ops = opEntryPointMap.get(entryPoint)
                if (ops) {
                    const txHash = await this.sendToExecutor(entryPoint, ops)

                    if (!txHash) {
                        throw new Error("no tx hash")
                    }

                    txHashes.push(txHash)
                } else {
                    this.logger.warn(
                        { entryPoint },
                        "no user operations for entry point"
                    )
                }
            })
        )

        return txHashes
    }

    async sendToExecutor(
        entryPoint: Address,
        mempoolOps: MempoolUserOperation[]
    ) {
        const ops = mempoolOps
            .filter((op) => !isCompressedType(op))
            .map((op) => op as UserOperation)
        const compressedOps = mempoolOps
            .filter((op) => isCompressedType(op))
            .map((op) => op as CompressedUserOperation)

        const bundles: BundleResult[][] = []
        if (ops.length > 0) {
            bundles.push(await this.executor.bundle(entryPoint, ops))
        }
        if (compressedOps.length > 0) {
            bundles.push(
                await this.executor.bundleCompressed(entryPoint, compressedOps)
            )
        }

        for (const bundle of bundles) {
            const isBundleSuccess = bundle.every(
                (result) => result.status === "success"
            )
            if (isBundleSuccess) {
                this.metrics.bundlesSubmitted
                    .labels({ status: "success" })
                    .inc()
            } else {
                this.metrics.bundlesSubmitted.labels({ status: "failed" }).inc()
            }
        }

        const results = bundles.flat()

        const filteredOutOps = mempoolOps.length - results.length
        if (filteredOutOps > 0) {
            this.logger.debug(
                { filteredOutOps },
                "user operations filtered out"
            )
            this.metrics.userOperationsSubmitted
                .labels({ status: "filtered" })
                .inc(filteredOutOps)
        }

        let txHash: HexData32 | undefined = undefined
        for (const result of results) {
            if (result.status === "success") {
                const res = result.value

                this.mempool.markSubmitted(
                    res.userOperation.userOperationHash,
                    res.transactionInfo
                )
                // this.monitoredTransactions.set(result.transactionInfo.transactionHash, result.transactionInfo)
                this.monitor.setUserOperationStatus(
                    res.userOperation.userOperationHash,
                    {
                        status: "submitted",
                        transactionHash: res.transactionInfo.transactionHash
                    }
                )
                txHash = res.transactionInfo.transactionHash
                this.startWatchingBlocks(this.handleBlock.bind(this))
                this.metrics.userOperationsSubmitted
                    .labels({ status: "success" })
                    .inc()
            }
            if (result.status === "failure") {
                const { userOpHash, reason } = result.error
                this.mempool.removeProcessing(userOpHash)
                this.eventManager.emitDropped(
                    userOpHash,
                    reason,
                    getAAError(reason)
                )
                this.monitor.setUserOperationStatus(userOpHash, {
                    status: "rejected",
                    transactionHash: null
                })
                this.logger.warn(
                    {
                        userOperation: JSON.stringify(
                            result.error.userOperation,
                            (_k, v) =>
                                typeof v === "bigint" ? v.toString() : v
                        ),
                        userOpHash,
                        reason
                    },
                    "user operation rejected"
                )
                this.metrics.userOperationsSubmitted
                    .labels({ status: "failed" })
                    .inc()
            }
            if (result.status === "resubmit") {
                this.logger.info(
                    {
                        userOpHash: result.info.userOpHash,
                        reason: result.info.reason
                    },
                    "resubmitting user operation"
                )
                this.mempool.removeProcessing(result.info.userOpHash)
                this.mempool.add(
                    result.info.userOperation,
                    result.info.entryPoint
                )
                this.metrics.userOperationsResubmitted.inc()
            }
        }
        return txHash
    }

    async bundle() {
        const opsToBundle: UserOperationInfo[][] = []

        while (true) {
            const ops = await this.mempool.process(5_000_000n, 1)
            if (ops?.length > 0) {
                opsToBundle.push(ops)
            } else {
                break
            }
        }

        if (opsToBundle.length === 0) {
            return
        }

        await Promise.all(
            opsToBundle.map(async (ops) => {
                const opEntryPointMap = new Map<
                    Address,
                    MempoolUserOperation[]
                >()

                for (const op of ops) {
                    if (!opEntryPointMap.has(op.entryPoint)) {
                        opEntryPointMap.set(op.entryPoint, [])
                    }
                    opEntryPointMap
                        .get(op.entryPoint)
                        ?.push(op.mempoolUserOperation)
                }

                await Promise.all(
                    this.entryPoints.map(async (entryPoint) => {
                        const userOperations = opEntryPointMap.get(entryPoint)
                        if (userOperations) {
                            await this.sendToExecutor(
                                entryPoint,
                                userOperations
                            )
                        } else {
                            this.logger.warn(
                                { entryPoint },
                                "no user operations for entry point"
                            )
                        }
                    })
                )
            })
        )
    }

    startWatchingBlocks(handleBlock: (block: Block) => void): void {
        if (this.unWatch) {
            return
        }
        this.unWatch = this.publicClient.watchBlocks({
            onBlock: handleBlock,
            // onBlock: async (block) => {
            //     // Use an arrow function to ensure correct binding of `this`
            //     this.checkAndReplaceTransactions(block)
            //         .then(() => {
            //             this.logger.trace("block handled")
            //             // Handle the resolution of the promise here, if needed
            //         })
            //         .catch((error) => {
            //             // Handle any errors that occur during the execution of the promise
            //             this.logger.error({ error }, "error while handling block")
            //         })
            // },
            onError: (error) => {
                this.logger.error({ error }, "error while watching blocks")
            },
            emitMissed: false,
            includeTransactions: false,
            pollingInterval: this.pollingInterval
        })

        this.logger.debug("started watching blocks")
    }

    stopWatchingBlocks(): void {
        if (this.unWatch) {
            this.logger.debug("stopped watching blocks")
            this.unWatch()
            this.unWatch = undefined
        }
    }

    // update the current status of the bundling transaction/s
    private async refreshTransactionStatus(
        entryPoint: Address,
        transactionInfo: TransactionInfo
    ) {
        const {
            transactionHash: currentTransactionHash,
            userOperationInfos: opInfos,
            previousTransactionHashes,
            isVersion06
        } = transactionInfo

        const txHashesToCheck = [
            currentTransactionHash,
            ...previousTransactionHashes
        ]

        const transactionDetails = await Promise.all(
            txHashesToCheck.map(async (transactionHash) => ({
                transactionHash,
                ...(await getBundleStatus(
                    isVersion06,
                    transactionHash,
                    this.publicClient,
                    this.logger,
                    entryPoint
                ))
            }))
        )

        // first check if bundling txs returns status "mined", if not, check for reverted
        const mined = transactionDetails.find(
            ({ bundlingStatus }) => bundlingStatus.status === "included"
        )
        const reverted = transactionDetails.find(
            ({ bundlingStatus }) => bundlingStatus.status === "reverted"
        )
        const finalizedTransaction = mined ?? reverted

        if (!finalizedTransaction) {
            for (const { userOperationHash } of opInfos) {
                this.logger.trace(
                    {
                        userOperationHash,
                        currentTransactionHash
                    },
                    "user op still pending"
                )
            }
            return
        }

        const { bundlingStatus, transactionHash, blockNumber } =
            finalizedTransaction as {
                bundlingStatus: BundlingStatus
                blockNumber: bigint // block number is undefined only if transaction is not found
                transactionHash: `0x${string}`
            }

        this.logger.info(
            {
                bundlingStatus,
                blockNumber,
                transactionHash
            },
            "finalizedTransaction"
        )

        this.metrics.userOperationsOnChain
            .labels({ status: bundlingStatus.status })
            .inc(opInfos.length)

        if (bundlingStatus.status === "included") {
            const { userOperationDetails } = bundlingStatus
            opInfos.map((opInfo) => {
                const {
                    mempoolUserOperation: mUserOperation,
                    userOperationHash: userOpHash,
                    entryPoint,
                    firstSubmitted
                } = opInfo
                const opDetails = userOperationDetails[userOpHash]

                this.metrics.userOperationInclusionDuration.observe(
                    (Date.now() - firstSubmitted) / 1000
                )
                this.mempool.removeSubmitted(userOpHash)
                this.reputationManager.updateUserOperationIncludedStatus(
                    deriveUserOperation(mUserOperation),
                    entryPoint,
                    opDetails.accountDeployed
                )
                if (opDetails.status === "succesful") {
                    this.eventManager.emitIncludedOnChain(
                        userOpHash,
                        transactionHash,
                        blockNumber as bigint
                    )
                } else {
                    this.eventManager.emitExecutionRevertedOnChain(
                        userOpHash,
                        transactionHash,
                        opDetails.revertReason || "0x",
                        blockNumber as bigint
                    )
                }
                this.monitor.setUserOperationStatus(userOpHash, {
                    status: "included",
                    transactionHash
                })
                this.logger.info(
                    {
                        userOpHash,
                        transactionHash
                    },
                    "user op included"
                )
            })

            this.executor.markWalletProcessed(transactionInfo.executor)
        } else if (
            bundlingStatus.status === "reverted" &&
            bundlingStatus.isAA95
        ) {
            // resubmit with more gas when bundler encounters AA95
            const multiplier = this.aa95ResubmitMultiplier
            transactionInfo.transactionRequest.gas =
                (transactionInfo.transactionRequest.gas * multiplier) / 100n
            transactionInfo.transactionRequest.nonce += 1

            opInfos.map(({ userOperationHash }) => {
                this.mempool.removeSubmitted(userOperationHash)
            })
            await this.replaceTransaction(transactionInfo, "AA95")
        } else if (
            bundlingStatus.status === "reverted" &&
            bundlingStatus.reason?.includes("AA25")
        ) {
            await Promise.all(
                opInfos.map(({ userOperationHash }) => {
                    this.checkFrontrun({
                        userOperationHash,
                        transactionHash,
                        blockNumber
                    })
                })
            )
        } else {
            opInfos.map(({ userOperationHash }) => {
                this.mempool.removeSubmitted(userOperationHash)

                this.monitor.setUserOperationStatus(userOperationHash, {
                    status: "rejected",
                    transactionHash
                })
                this.eventManager.emitFailedOnChain(
                    userOperationHash,
                    transactionHash,
                    blockNumber as bigint
                )
                this.logger.info(
                    {
                        userOpHash: userOperationHash,
                        transactionHash
                    },
                    "user op failed onchain"
                )
            })

            this.executor.markWalletProcessed(transactionInfo.executor)
        }
    }

    checkFrontrun({
        userOperationHash,
        transactionHash,
        blockNumber
    }: {
        userOperationHash: HexData32
        transactionHash: Hash
        blockNumber: bigint
    }) {
        const unwatch = this.publicClient.watchBlockNumber({
            onBlockNumber: async (currentBlockNumber) => {
                if (currentBlockNumber > blockNumber + 1n) {
                    const userOperationReceipt =
                        await this.getUserOperationReceipt(userOperationHash)

                    this.logger.info(
                        {
                            userOperationReceipt
                        },
                        "userOperationReceipt"
                    )

                    if (userOperationReceipt) {
                        const transactionHash =
                            userOperationReceipt.receipt.transactionHash
                        const blockNumber =
                            userOperationReceipt.receipt.blockNumber

                        this.monitor.setUserOperationStatus(userOperationHash, {
                            status: "included",
                            transactionHash
                        })

                        this.eventManager.emitFrontranOnChain(
                            userOperationHash,
                            transactionHash,
                            blockNumber
                        )

                        this.logger.info(
                            {
                                userOpHash: userOperationHash,
                                transactionHash
                            },
                            "user op frontrun onchain"
                        )
                    } else {
                        this.monitor.setUserOperationStatus(userOperationHash, {
                            status: "rejected",
                            transactionHash
                        })
                        this.eventManager.emitFailedOnChain(
                            userOperationHash,
                            transactionHash,
                            blockNumber
                        )
                        this.logger.info(
                            {
                                userOpHash: userOperationHash,
                                transactionHash
                            },
                            "user op failed onchain - AA25"
                        )
                    }
                    unwatch()
                }
            }
        })
    }

    async getUserOperationReceipt(userOperationHash: HexData32) {
        const userOperationEventAbiItem = getAbiItem({
            abi: EntryPointV06Abi,
            name: "UserOperationEvent"
        })

        let fromBlock: bigint | undefined = undefined
        let toBlock: "latest" | undefined = undefined
        if (this.rpcMaxBlockRange !== undefined) {
            const latestBlock = await this.publicClient.getBlockNumber()
            fromBlock = latestBlock - BigInt(this.rpcMaxBlockRange)
            if (fromBlock < 0n) {
                fromBlock = 0n
            }
            toBlock = "latest"
        }

        const filterResult = await this.publicClient.getLogs({
            address: this.entryPoints,
            event: userOperationEventAbiItem,
            fromBlock,
            toBlock,
            args: {
                userOpHash: userOperationHash
            }
        })

        this.logger.debug(
            {
                filterResult: filterResult.length,
                userOperationEvent:
                    filterResult.length === 0
                        ? undefined
                        : filterResult[0].transactionHash
            },
            "filter result length"
        )

        if (filterResult.length === 0) {
            return null
        }

        const userOperationEvent = filterResult[0]
        // throw if any of the members of userOperationEvent are undefined
        if (
            userOperationEvent.args.actualGasCost === undefined ||
            userOperationEvent.args.sender === undefined ||
            userOperationEvent.args.nonce === undefined ||
            userOperationEvent.args.userOpHash === undefined ||
            userOperationEvent.args.success === undefined ||
            userOperationEvent.args.paymaster === undefined ||
            userOperationEvent.args.actualGasUsed === undefined
        ) {
            throw new Error("userOperationEvent has undefined members")
        }

        const txHash = userOperationEvent.transactionHash
        if (txHash === null) {
            // transaction pending
            return null
        }

        const getTransactionReceipt = async (
            txHash: HexData32
        ): Promise<TransactionReceipt> => {
            while (true) {
                try {
                    const transactionReceipt =
                        await this.publicClient.getTransactionReceipt({
                            hash: txHash
                        })

                    let effectiveGasPrice: bigint | undefined =
                        transactionReceipt.effectiveGasPrice ??
                        (transactionReceipt as any).gasPrice ??
                        undefined

                    if (effectiveGasPrice === undefined) {
                        const tx = await this.publicClient.getTransaction({
                            hash: txHash
                        })
                        effectiveGasPrice = tx.gasPrice ?? undefined
                    }

                    if (effectiveGasPrice) {
                        transactionReceipt.effectiveGasPrice = effectiveGasPrice
                    }

                    return transactionReceipt
                } catch (e) {
                    if (e instanceof TransactionReceiptNotFoundError) {
                        continue
                    }

                    throw e
                }
            }
        }

        const receipt = await getTransactionReceipt(txHash)
        const logs = receipt.logs

        if (
            logs.some(
                (log) =>
                    log.blockHash === null ||
                    log.blockNumber === null ||
                    log.transactionIndex === null ||
                    log.transactionHash === null ||
                    log.logIndex === null ||
                    log.topics.length === 0
            )
        ) {
            // transaction pending
            return null
        }

        const userOperationRevertReasonAbi = parseAbi([
            "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)"
        ])

        const userOperationRevertReasonTopicEvent = encodeEventTopics({
            abi: userOperationRevertReasonAbi
        })[0]

        let entryPoint: Address = zeroAddress
        let revertReason = undefined

        let startIndex = -1
        let endIndex = -1
        logs.forEach((log, index) => {
            if (log?.topics[0] === userOperationEvent.topics[0]) {
                // process UserOperationEvent
                if (log.topics[1] === userOperationEvent.topics[1]) {
                    // it's our userOpHash. save as end of logs array
                    endIndex = index
                    entryPoint = log.address
                } else if (endIndex === -1) {
                    // it's a different hash. remember it as beginning index, but only if we didn't find our end index yet.
                    startIndex = index
                }
            }

            if (log?.topics[0] === userOperationRevertReasonTopicEvent) {
                // process UserOperationRevertReason
                if (log.topics[1] === userOperationEvent.topics[1]) {
                    // it's our userOpHash. capture revert reason.
                    const decodedLog = decodeEventLog({
                        abi: userOperationRevertReasonAbi,
                        data: log.data,
                        topics: log.topics
                    })

                    revertReason = decodedLog.args.revertReason
                }
            }
        })
        if (endIndex === -1) {
            throw new Error("fatal: no UserOperationEvent in logs")
        }

        const filteredLogs = logs.slice(startIndex + 1, endIndex)

        const logsParsing = z.array(logSchema).safeParse(filteredLogs)
        if (!logsParsing.success) {
            const err = fromZodError(logsParsing.error)
            throw err
        }

        const receiptParsing = receiptSchema.safeParse({
            ...receipt,
            status: receipt.status === "success" ? 1 : 0
        })
        if (!receiptParsing.success) {
            const err = fromZodError(receiptParsing.error)
            throw err
        }

        let paymaster: Address | undefined = userOperationEvent.args.paymaster
        paymaster = paymaster === zeroAddress ? undefined : paymaster

        const userOperationReceipt: GetUserOperationReceiptResponseResult = {
            userOpHash: userOperationHash,
            entryPoint,
            sender: userOperationEvent.args.sender,
            nonce: userOperationEvent.args.nonce,
            paymaster,
            actualGasUsed: userOperationEvent.args.actualGasUsed,
            actualGasCost: userOperationEvent.args.actualGasCost,
            success: userOperationEvent.args.success,
            reason: revertReason,
            logs: logsParsing.data,
            receipt: receiptParsing.data
        }

        return userOperationReceipt
    }

    async refreshUserOperationStatuses(): Promise<void> {
        const ops = this.mempool.dumpSubmittedOps()

        const opEntryPointMap = new Map<Address, SubmittedUserOperation[]>()

        for (const op of ops) {
            if (!opEntryPointMap.has(op.userOperation.entryPoint)) {
                opEntryPointMap.set(op.userOperation.entryPoint, [])
            }
            opEntryPointMap.get(op.userOperation.entryPoint)?.push(op)
        }

        await Promise.all(
            this.entryPoints.map(async (entryPoint) => {
                const ops = opEntryPointMap.get(entryPoint)

                if (ops) {
                    const txs = getTransactionsFromUserOperationEntries(ops)

                    await Promise.all(
                        txs.map(async (txInfo) => {
                            await this.refreshTransactionStatus(
                                entryPoint,
                                txInfo
                            )
                        })
                    )
                } else {
                    this.logger.warn(
                        { entryPoint },
                        "no user operations for entry point"
                    )
                }
            })
        )
    }

    async handleBlock(block: Block) {
        if (this.currentlyHandlingBlock) {
            return
        }

        this.currentlyHandlingBlock = true

        this.logger.debug({ blockNumber: block.number }, "handling block")

        const submittedEntries = this.mempool.dumpSubmittedOps()
        if (submittedEntries.length === 0) {
            this.stopWatchingBlocks()
            this.currentlyHandlingBlock = false
            return
        }

        // refresh op statuses
        await this.refreshUserOperationStatuses()

        // for all still not included check if needs to be replaced (based on gas price)
        const gasPriceParameters = await this.gasPriceManager.getGasPrice()
        this.logger.trace(
            { gasPriceParameters },
            "fetched gas price parameters"
        )

        const transactionInfos = getTransactionsFromUserOperationEntries(
            this.mempool.dumpSubmittedOps()
        )

        await Promise.all(
            transactionInfos.map(async (txInfo) => {
                if (
                    txInfo.transactionRequest.maxFeePerGas >=
                        gasPriceParameters.maxFeePerGas &&
                    txInfo.transactionRequest.maxPriorityFeePerGas >=
                        gasPriceParameters.maxPriorityFeePerGas
                ) {
                    return
                }

                await this.replaceTransaction(txInfo, "gas_price")
            })
        )

        // for any left check if enough time has passed, if so replace
        const transactionInfos2 = getTransactionsFromUserOperationEntries(
            this.mempool.dumpSubmittedOps()
        )
        await Promise.all(
            transactionInfos2.map(async (txInfo) => {
                if (Date.now() - txInfo.lastReplaced < 5 * 60 * 1000) {
                    return
                }

                await this.replaceTransaction(txInfo, "stuck")
            })
        )

        this.currentlyHandlingBlock = false
    }

    async replaceTransaction(
        txInfo: TransactionInfo,
        reason: string
    ): Promise<void> {
        let replaceResult: ReplaceTransactionResult | undefined = undefined
        try {
            replaceResult = await this.executor.replaceTransaction(txInfo)
        } finally {
            this.metrics.replacedTransactions
                .labels({ reason, status: replaceResult?.status || "failed" })
                .inc()
        }
        if (replaceResult.status === "failed") {
            txInfo.userOperationInfos.map((opInfo) => {
                this.mempool.removeSubmitted(opInfo.userOperationHash)
            })

            this.logger.warn(
                { oldTxHash: txInfo.transactionHash, reason },
                "failed to replace transaction"
            )

            return
        }
        if (replaceResult.status === "potentially_already_included") {
            this.logger.info(
                { oldTxHash: txInfo.transactionHash, reason },
                "transaction potentially already included"
            )
            txInfo.timesPotentiallyIncluded += 1

            if (txInfo.timesPotentiallyIncluded >= 3) {
                txInfo.userOperationInfos.map((opInfo) => {
                    this.mempool.removeSubmitted(opInfo.userOperationHash)
                })
                this.executor.markWalletProcessed(txInfo.executor)

                this.logger.warn(
                    { oldTxHash: txInfo.transactionHash, reason },
                    "transaction potentially already included too many times, removing"
                )
            }

            return
        }

        const newTxInfo = replaceResult.transactionInfo

        const missingOps = txInfo.userOperationInfos.filter(
            (info) =>
                !newTxInfo.userOperationInfos
                    .map((ni) => ni.userOperationHash)
                    .includes(info.userOperationHash)
        )
        const matchingOps = txInfo.userOperationInfos.filter((info) =>
            newTxInfo.userOperationInfos
                .map((ni) => ni.userOperationHash)
                .includes(info.userOperationHash)
        )

        matchingOps.map((opInfo) => {
            this.mempool.replaceSubmitted(opInfo, newTxInfo)
        })

        missingOps.map((opInfo) => {
            this.mempool.removeSubmitted(opInfo.userOperationHash)
            this.logger.warn(
                {
                    oldTxHash: txInfo.transactionHash,
                    newTxHash: newTxInfo.transactionHash,
                    reason
                },
                "missing op in new tx"
            )
        })

        this.logger.info(
            {
                oldTxHash: txInfo.transactionHash,
                newTxHash: newTxInfo.transactionHash,
                reason
            },
            "replaced transaction"
        )

        return
    }
}
