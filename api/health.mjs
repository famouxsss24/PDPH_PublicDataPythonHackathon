export default {
  fetch(request) {
    if (request.method !== "GET") {
      return Response.json({ detail: "Method not allowed" }, { status: 405 });
    }
    return Response.json(
      {
        status: "ok",
        deployment_mode: "vercel_snapshot",
        service_area: "Nowon-gu walking network",
        weather: {
          provider: "Open-Meteo",
          current_apparent_temperature: true,
          requires_key: false,
        },
      },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } },
    );
  },
};
