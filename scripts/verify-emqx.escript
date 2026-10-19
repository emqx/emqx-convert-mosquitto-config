#!/usr/bin/env escript
%%! +S 2:2 -boot_var RELEASE_LIB /opt/emqx/lib
%% Use the parser and schema bundled with the EMQX image, not a second HOCON
%% implementation or hand-written unit conversion rules.
-mode(compile).

main(Args) ->
    code:add_paths(filelib:wildcard("/opt/emqx/lib/*/ebin")),
    try run(Args) of
        ok -> ok
    catch
        Class:Reason ->
            io:format(standard_error, "Verification failed: ~p:~p~n", [Class, Reason]),
            halt(1)
    end.

run(["keys", Path]) ->
    Config = read_config(Path),
    true = map_size(Config) > 0,
    lists:foreach(fun(Key) -> io:format("~ts~n", [Key]) end, lists:sort(maps:keys(Config)));
run(["dependencies", Path]) ->
    Config = maps:with([<<"mqtt">>, <<"zones">>], read_config(Path)),
    true = map_size(Config) > 0,
    io:put_chars(hocon_pp:do(Config, #{}));
run(["compare", ExpectedPath, ActualPath]) ->
    Expected = read_config(ExpectedPath),
    Actual = read_config(ActualPath),
    true = map_size(Expected) > 0,
    %% Require all explicitly generated paths to exist BEFORE filling schema
    %% defaults. Otherwise a missing runtime field matching a default can pass.
    Leaves = leaves(Expected, Actual, []),
    Roots = maps:keys(Expected),
    Options = #{atom_key => false, required => false, apply_override_envs => false},
    NormalExpected = hocon_tconf:check_plain(emqx_conf_schema, Expected, Options, Roots),
    NormalActual = hocon_tconf:check_plain(emqx_conf_schema, Actual, Options, Roots),
    lists:foreach(
        fun(Path) ->
            Wanted = normalize(Path, get(Path, NormalExpected)),
            Found = normalize(Path, get(Path, NormalActual)),
            case Wanted =:= Found of
                true -> ok;
                false -> error({value_mismatch, format_path(Path), #{expected => Wanted, actual => Found}})
            end
        end,
        Leaves
    ),
    io:format("Verified ~B generated values across ~B configuration roots.~n", [length(Leaves), length(Roots)]).

read_config(Path) ->
    {ok, Config} = hocon:load(Path),
    true = is_map(Config),
    Config.

leaves(Expected, Actual, Path) when is_map(Expected), is_map(Actual) ->
    lists:flatmap(
        fun({Key, Value}) ->
            Next = Path ++ [Key],
            case maps:find(Key, Actual) of
                {ok, Found} -> leaves(Value, Found, Next);
                error -> error({missing_runtime_path, format_path(Next)})
            end
        end,
        lists:sort(maps:to_list(Expected))
    );
leaves(Expected, Actual, Path) when is_list(Expected), is_list(Actual) ->
    case length(Expected) =:= length(Actual) of
        false -> error({array_length_mismatch, format_path(Path), length(Expected), length(Actual)});
        true when Expected =:= [] -> [Path];
        true -> lists:flatmap(
            fun({Index, {Wanted, Found}}) -> leaves(Wanted, Found, Path ++ [Index]) end,
            lists:zip(lists:seq(1, length(Expected)), lists:zip(Expected, Actual))
        )
    end;
leaves(Expected, Actual, Path) when is_map(Expected); is_map(Actual); is_list(Expected); is_list(Actual) ->
    error({shape_mismatch, format_path(Path)});
leaves(_, _, Path) -> [Path].

get([], Value) -> Value;
get([Key | Rest], Value) when is_binary(Key) -> get(Rest, maps:get(Key, Value));
get([Index | Rest], Value) when is_integer(Index) -> get(Rest, lists:nth(Index, Value)).

%% EMQX rewrites log paths under its log directory to ${EMQX_LOG_DIR}/... .
%% Use the broker's interpolation rules ONLY for this file-path field; strings
%% such as mountpoints must still compare literally. Run via emqx escript so
%% the path environment is the same as for the broker's CLI.
normalize([<<"log">>, <<"file">>, _Handler, <<"path">>], Value) ->
    filename:absname(emqx_schema:naive_env_interpolation(Value));
normalize(_, Value) -> Value.

format_path(Path) ->
    iolist_to_binary(lists:join(".", [
        case Part of
            N when is_integer(N) -> integer_to_binary(N);
            Key -> Key
        end || Part <- Path
    ])).
