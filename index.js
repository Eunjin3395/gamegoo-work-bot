require("dotenv").config();
const AWS = require("aws-sdk");
const dayjs = require("dayjs");
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);

const getKSTNow = () => dayjs().tz("Asia/Seoul");
const formatKST = (d = getKSTNow()) => d.format("YYYY-MM-DD HH:mm:ss");
const formatDate = () => getKSTNow().format("YYYY-MM-DD");

const docClient = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Discord 봇 설정
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, // 메시지 감지를 위한 인텐트
    GatewayIntentBits.MessageContent, // 메시지 내용 접근을 위한 인텐트
  ],
  partials: [Partials.Channel],
});

const CURRENT_ONLINE_TABLE = "Gamegoo_Current_Members";
const WORK_HISTORY_TABLE = "Gamegoo_Work_Time_History";
const WORK_CHANNEL_ID = process.env.WORK_CHANNEL_ID; // 캠/화면공유 채널 id

// 이름 -> discord id
const USERNAME_TO__DISCORD_ID = {
  은진: "eunjin3395",
  예림: "qwertyuip_ye",
  혜연: "hykkk",
  성욱: "_sungwook",
  효림: "rimi_lim",
  진형: "jang_jin_hyeong",
  하은: "android5050",
};

const updateWorkTime = async (id, startAt, endAt, duration) => {
  const start = dayjs(startAt);
  const end = dayjs(endAt);

  // 자정 기준 (start 다음날 00:00:00)
  const midnight = start.endOf("day").add(1, "millisecond"); // 00:00:00.000 of 다음날

  if (end.isBefore(midnight)) {
    // ✅ 자정을 넘지 않은 경우 → 1 row 저장
    await putWorkItem(id, startAt, endAt, duration);
  } else {
    // ✅ 자정을 넘은 경우 → 2 row 저장
    const firstEnd = midnight.format("YYYY-MM-DD HH:mm:ss");
    const secondStart = firstEnd;
    const secondEnd = endAt;

    const firstDuration = dayjs(firstEnd).diff(start, "minute", true);
    const secondDuration = end.diff(dayjs(secondStart), "minute", true);

    await putWorkItem(id, startAt, firstEnd, firstDuration);
    await putWorkItem(id, secondStart, secondEnd, secondDuration);
  }
};

// ✅ 단일 row 저장용 함수
const putWorkItem = async (id, startAt, endAt, duration) => {
  const params = {
    TableName: WORK_HISTORY_TABLE,
    Item: {
      id,
      startAt, // Sort Key
      endAt,
      duration,
    },
  };

  try {
    await docClient.put(params).promise();
    console.log(`✅ ${id} 작업 저장: ${startAt} ~ ${endAt} (${duration.toFixed(2)}분)`);
  } catch (err) {
    console.error("❌ 저장 실패:", err);
  }
};

// 음성 채널에 입장 이벤트 리스너
client.on("voiceStateUpdate", async (oldState, newState) => {
  const oldChannel = oldState.channelId; // 변경 전 채널 ID
  const newChannel = newState.channelId; // 변경 후 채널 ID
  const discordId = newState.member?.user?.username;
  const now = formatKST();

  if (!discordId) return;

  const isJoined = newChannel === WORK_CHANNEL_ID;
  const isLeft = oldChannel === WORK_CHANNEL_ID;

  // 채널 퇴장 로직
  try {
    if (isLeft && oldChannel !== newChannel) {
      // 1. DynamoDB에서 joinedAt 조회
      const result = await docClient
        .get({
          TableName: CURRENT_ONLINE_TABLE,
          Key: { id: discordId },
        })
        .promise();

      const joinedAt = result?.Item?.joinedAt;

      if (joinedAt) {
        // 2. 시간 차이 계산
        const durationMinutes = dayjs(now).diff(dayjs(joinedAt), "minute", true); // 소수점 포함
        console.log(`[퇴장] ${discordId} from ${oldChannel} at ${now}`);

        // 3. 작업한 시간 저장
        await updateWorkTime(discordId, joinedAt, now, durationMinutes);
      } else {
        console.log(`[퇴장] ${discordId} from ${oldChannel} at ${now} (joinedAt 없음)`);
      }

      await docClient
        .delete({
          TableName: CURRENT_ONLINE_TABLE,
          Key: { id: discordId },
        })
        .promise();
    }
  } catch (err) {
    console.error("❌ 퇴장 로직 중 DynamoDB 처리 오류:", err);
  }

  // 채널 입장 로직
  try {
    if (isJoined && newChannel !== oldChannel) {
      await docClient
        .put({
          TableName: CURRENT_ONLINE_TABLE,
          Item: { id: discordId, joinedAt: now },
        })
        .promise();
      console.log(`[입장] ${discordId} to ${newChannel} at ${now}`);
    }
  } catch (err) {
    console.error("❌ 입장 로직 중 DynamoDB 처리 오류:", err);
  }
});

client.once("clientReady", async () => {
  console.log(`${client.user.tag} 봇이 실행되었습니다.`);
});

client.login(process.env.DISCORD_TOKEN);
